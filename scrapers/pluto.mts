/**
 * Pluto TV -- free, ad-supported, fully legal linear TV (~400 channels in
 * the US, a different line-up per region).
 *
 * Three unauthenticated steps, all on Pluto's own public web-app API:
 *
 *   1. `GET boot.pluto.tv/v4/start?...` with a fresh random `clientID`
 *      answers a `sessionToken` (a 24-hour JWT), the `stitcher` host to
 *      use, `stitcherParams` (a query string the stitcher expects), and the
 *      region Pluto placed the caller in (`session.activeRegion`).
 *   2. `GET service-channels.../v2/guide/channels` and `.../categories`
 *      with that JWT as a Bearer token list every channel (name, logo,
 *      `stitched.path`) and the category each belongs to.
 *   3. Each stream URL is `<stitcher>/v2<stitched.path>?<stitcherParams>
 *      &jwt=<sessionToken>&masterJWTPassthrough=true`.
 *
 * WHY THE JWT IS BAKED INTO EVERY URL: the older JWT-less host
 * (`service-stitcher.clusters.pluto.tv/stitch/hls/...`, still used by
 * many IPTV lists) still answers 200 with a valid playlist -- but every
 * segment in it is Pluto's generic "takedown slate", not the channel.
 * Only the JWT-carrying stitcher serves real programming. The token lasts
 * 24 hours and the host rebuilds every 12, so a URL is always replaced
 * before it expires. The JWT also records the caller's IP/region at boot
 * time; a player on a very different network from the stremio-tv server
 * may therefore see a different region's slate or a geo-block.
 *
 * The line-up is whatever region the SERVER running `build()` sits in --
 * Pluto has no region parameter an anonymous client can override.
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
    by?: string;
    group?: string;
    filter?: { countries?: string[]; categories?: string[]; genres?: string[]; languages?: string[]; market?: "home-first" | "first" };
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

const SCRAPER_ID = "pluto";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: `fetch()` resolves on
    // headers, and the body read (`.json()`/`.text()`) that follows is
    // still tied to this signal -- clearing the timer here would leave a
    // stalled body able to hang build() forever. Aborting after the body
    // is already read is a no-op; `unref()` keeps the timer from holding
    // the process open.
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();

    try {
        return await work(controller.signal);
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

interface Boot {
    servers?: { channels?: string; stitcher?: string };
    session?: { activeRegion?: string };
    stitcherParams?: string;
    sessionToken?: string;
}

interface PlutoChannel {
    id: string;
    slug?: string;
    name?: string;
    stitched?: { path?: string };
    images?: Array<{ type?: string; url?: string }>;
}

interface PlutoCategory {
    name?: string;
    channelIDs?: string[];
}

async function getJson<T>(url: string, token?: string): Promise<T> {
    const response = await withTimeout((signal) =>
        fetch(url, {
            signal,
            headers: { "User-Agent": UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
        })
    );
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return (await response.json()) as T;
}

function flagEmoji(code: string): string {
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function logoFor(channel: PlutoChannel): string {
    const images = channel.images || [];
    const pick = images.find((i) => i.type === "colorLogoPNG") || images.find((i) => i.type === "logo");
    return pick?.url || "";
}

async function build(): Promise<ScrapedCatalogue> {
    const clientId = crypto.randomUUID();
    const bootQuery = new URLSearchParams({
        appName: "web",
        appVersion: "9.0.0",
        deviceVersion: "128.0.0",
        deviceModel: "web",
        deviceMake: "chrome",
        deviceType: "web",
        clientID: clientId,
        clientModelNumber: "1.0.0",
        serverSideAds: "false"
    });
    const boot = await getJson<Boot>(`https://boot.pluto.tv/v4/start?${bootQuery}`);
    const token = boot.sessionToken;
    const stitcher = boot.servers?.stitcher;
    const channelsHost = boot.servers?.channels || "https://service-channels.clusters.pluto.tv";
    if (!token || !stitcher || !boot.stitcherParams) throw new Error("pluto: boot response missing token/stitcher");

    const [channelResponse, categoryResponse] = await Promise.all([
        getJson<{ data?: PlutoChannel[] }>(`${channelsHost}/v2/guide/channels?channelIds=&offset=0&limit=5000&lang=en`, token),
        getJson<{ data?: PlutoCategory[] }>(`${channelsHost}/v2/guide/categories?lang=en&offset=0&limit=500`, token).catch(
            () => ({ data: [] as PlutoCategory[] })
        )
    ]);

    const categoriesById = new Map<string, string[]>();
    for (const category of categoryResponse.data || []) {
        if (!category.name) continue;
        for (const id of category.channelIDs || []) {
            const list = categoriesById.get(id) || [];
            list.push(category.name.toLowerCase());
            categoriesById.set(id, list);
        }
    }

    const region = (boot.session?.activeRegion || "").toUpperCase();
    const channels: ScrapedChannel[] = [];

    for (const entry of channelResponse.data || []) {
        const path = entry.stitched?.path;
        if (!entry.id || !entry.name || !path) continue;

        channels.push({
            id: idFor(entry.slug || entry.id),
            name: entry.name.trim(),
            country: region,
            countryName: "",
            countryFlag: flagEmoji(region),
            categories: categoriesById.get(entry.id) || [],
            languages: [],
            logo: logoFor(entry),
            website: entry.slug ? `https://pluto.tv/live-tv/${entry.slug}` : "https://pluto.tv/",
            network: "Pluto TV",
            streams: [
                {
                    url: `${stitcher}/v2${path}?${boot.stitcherParams}&jwt=${token}&masterJWTPassthrough=true`,
                    quality: "",
                    labels: [],
                    referrer: "",
                    userAgent: ""
                }
            ]
        });
    }

    if (!channels.length) throw new Error("pluto: channel list came back empty");
    return { channels, rails: categoryRails(channels, "Pluto TV") };
}

// -------------------------------------------------------------------------
// Rails from this source's own category words.
//
// The host already folds the common words (news, sports, kids ...) into its
// genre rails; what is left -- "Sitcoms + Comedy", "Animals & Nature" -- is
// this source's own vocabulary, so it is declared as rails of its own,
// grouped under "Categories / <source>" in the lists of every rail.
// -------------------------------------------------------------------------

/** Words the host's genre rails already carry, so a rail of their own would repeat one. */
const GENRE_WORDS = new Set([
    "news", "sports", "sport", "movies", "movie", "films", "film", "kids", "children", "animation", "music",
    "documentary", "lifestyle", "business", "entertainment", "general", "religious", "education", "culture",
    "legislative", "series", "family", "weather", "other"
]);

/** Never offered as a rail: shopping and adult shelves. */
const UNLISTED = /\b(shop\w*|xxx|adult|erotic\w*|sinnlich\w*|telesales|18\+)\b/i;

function categoryRails(channels: ScrapedChannel[], sourceName: string, min = 5, cap = 30): ScrapedRail[] {
    const counts = new Map<string, number>();

    for (const channel of channels) {
        for (const word of new Set(channel.categories)) counts.set(word, (counts.get(word) || 0) + 1);
    }

    const taken = new Set<string>();
    const rails: ScrapedRail[] = [];
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    for (const [word, count] of ranked) {
        const slug = `cat-${word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");

        if (count < min || word.length > 40 || GENRE_WORDS.has(word) || UNLISTED.test(word) || slug === "cat" || taken.has(slug)) continue;

        taken.add(slug);
        rails.push({
            id: slug,
            heading: word.replace(/(^|[\s(+&/-])(\p{L})/gu, (_all, lead: string, first: string) => lead + first.toUpperCase()).replace(/\bTv\b/g, "TV"),
            by: `From ${sourceName}`,
            channelIds: [],
            filter: { categories: [word] },
            group: `Categories/${sourceName.replace(/\//g, " ")}`
        });

        if (rails.length >= cap) break;
    }

    return rails;
}

export const plutoScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Pluto TV",
    version: "1.1.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/pluto.mts` -- prints a channel count and the first
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
