/**
 * Xumo Play -- free, ad-supported, fully legal US linear TV (~450
 * channels), from Xumo's own public web-app API. US-only: from outside
 * the US, `play.xumo.com` 302s to `/geo-block` and this API is expected
 * to refuse or return nothing, in which case `build()` throws and the
 * host keeps the last good catalogue.
 *
 *   1. `GET valencia-app-mds.xumo.com/v2/channels/list/10006.json` -- the
 *      web app's channel list: `channel.item[]` with `title`,
 *      `guid.value` (the channel id), `genre[]`, `properties.is_live`.
 *   2. `GET .../v2/channels/channel/<id>/broadcast.json?hour=<UTC hour>`
 *      -- answers `ssaiStreamUrl`, a static per-channel
 *      `<cloudfront>/10001/<id>/hls/playlist.m3u8?ads.*=...` master. Its
 *      query string carries a long tail of unfilled `[PLACEHOLDER]` ad
 *      macros meant for native apps; those are dropped (verified: the
 *      playlist and its `wurl.com`/MediaTailor segments still play), but
 *      the rest of the query has to stay -- the bare path 400s with
 *      "Unable to resolve origin prefix after interpolation."
 *
 *   3. About 40% of channels answer `broadcast.json` with no
 *      `ssaiStreamUrl`, only `assets: [{ id, live: true }]`. For those,
 *      `GET .../v2/assets/asset/<asset id>.json?f=providers` lists
 *      `providers[].sources[].uri` -- the same cloudfront URL shape
 *      (`.../hls/index.m3u8?...`), cleaned the same way. A channel with
 *      neither is skipped.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------

interface ScrapedStream {
    url: string;
    quality: string;
    labels: string[];
    referrer: string;
    userAgent: string;
}

interface ScrapedChannel {
    id: string;
    name: string;
    country: string;
    countryName: string;
    countryFlag: string;
    categories: string[];
    languages: string[];
    logo: string;
    website: string;
    network: string;
    streams: ScrapedStream[];
}

interface ScrapedRail {
    id: string;
    heading: string;
    channelIds: string[];
}

interface ScrapedCatalogue {
    channels: ScrapedChannel[];
    rails?: ScrapedRail[];
}

type ScraperConfigValue = string | number | boolean;

interface ScraperConfigField {
    key: string;
    label: string;
    type: "number" | "string" | "boolean";
    default: ScraperConfigValue;
    min?: number;
    max?: number;
    help?: string;
}

interface ScraperTaskContext {
    config: Record<string, ScraperConfigValue>;
    runTask(id: string): Promise<void>;
}

interface ScraperTask {
    id: string;
    label: string;
    dependsOn?: string[];
    intervalConfigKey?: string;
    run(ctx: ScraperTaskContext): Promise<void>;
}

interface Scraper {
    id: string;
    name: string;
    version?: string;
    configSchema?: ScraperConfigField[];
    tasks?: ScraperTask[];
    build(): Promise<ScrapedCatalogue>;
}

const SCRAPER_ID = "xumo";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await work(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function run(): Promise<void> {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index] as T);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
    return results;
}

const API = "https://valencia-app-mds.xumo.com/v2";

interface XumoItem {
    title?: string;
    guid?: { value?: string };
    genre?: Array<{ value?: string }>;
    properties?: { is_live?: string };
}

async function getJson<T>(url: string): Promise<T> {
    const response = await withTimeout((signal) => fetch(url, { signal }));
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return (await response.json()) as T;
}

/** Drops the `[MACRO]` placeholders native apps are meant to fill in. */
function cleanStreamUrl(raw: string): string {
    const url = new URL(raw);
    for (const [key, value] of [...url.searchParams]) {
        if (value.includes("[")) url.searchParams.delete(key);
    }
    return url.href;
}

async function streamFor(id: string): Promise<string | null> {
    try {
        const hour = new Date().getUTCHours();
        const body = await getJson<{ ssaiStreamUrl?: string; assets?: Array<{ id?: string }> }>(
            `${API}/channels/channel/${id}/broadcast.json?hour=${hour}`
        );
        if (body.ssaiStreamUrl) return cleanStreamUrl(body.ssaiStreamUrl);

        const assetId = body.assets?.[0]?.id;
        if (!assetId) return null;
        const asset = await getJson<{ providers?: Array<{ sources?: Array<{ uri?: string }> }> }>(
            `${API}/assets/asset/${assetId}.json?f=providers`
        );
        const uris = (asset.providers || []).flatMap((p) => p.sources || []).map((s) => s.uri || "");
        const uri = uris.find((u) => /\.m3u8/.test(u)) || uris.find((u) => /^https?:\/\//.test(u));
        return uri ? cleanStreamUrl(uri) : null;
    } catch {
        return null;
    }
}

async function build(): Promise<ScrapedCatalogue> {
    const list = await getJson<{ channel?: { item?: XumoItem[] } }>(
        `${API}/channels/list/10006.json?sort=hybrid&geoId=unknown`
    );
    const items = (list.channel?.item || []).filter(
        (item) => item.guid?.value && item.title && item.properties?.is_live !== "false"
    );
    if (!items.length) throw new Error("xumo: channel list came back empty (geo-blocked?)");

    const urls = await mapWithConcurrency(items, 12, (item) => streamFor(item.guid!.value!));

    const channels: ScrapedChannel[] = [];
    items.forEach((item, index) => {
        const url = urls[index];
        if (!url) return;
        const id = item.guid!.value!;
        channels.push({
            id: idFor(id),
            name: item.title!.trim(),
            country: "US",
            countryName: "United States",
            countryFlag: "🇺🇸",
            categories: (item.genre || []).map((g) => (g.value || "").toLowerCase()).filter(Boolean),
            languages: [],
            logo: `https://image.xumo.com/v1/channels/channel/${id}/248x140.png?type=color_onBlack`,
            website: "https://play.xumo.com/",
            network: "Xumo Play",
            streams: [{ url, quality: "", labels: ["Geo-blocked"], referrer: "", userAgent: "" }]
        });
    });

    if (!channels.length) throw new Error("xumo: no channel had a stream URL");
    return { channels };
}

export const xumoScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Xumo Play",
    version: "1.0.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/xumo.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
            console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
            console.log(catalogue.channels[0] || "(none)");
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
