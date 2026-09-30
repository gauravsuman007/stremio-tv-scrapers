/**
 * CXtv (cxtvlive.com) -- a ~2.6k-channel user-submitted live-TV directory,
 * heavy on Brazilian/Latin-American local and religious stations. About
 * two thirds of a 30-page sample were stream URLs iptv-org does not list.
 *
 * No API. `sitemap.xml` enumerates every channel page
 * (`/live-tv/<slug>`), and each page carries its stream as a plain
 * `data-stream-url="<m3u8>"` attribute (the same URL also appears as the
 * JSON-LD VideoObject's `contentUrl`), plus the channel's name (`<h1>`),
 * logo (`og:image`), categories (`/tv/category/<x>` links) and country
 * (`/tv/country/<x>` link text). Every page has to be fetched -- country
 * and category listing pages carry no stream URLs -- so this is ~2.6k
 * small GETs per build, run 8 at a time.
 *
 * Pages whose player is an iframe/YouTube embed rather than a direct URL
 * have no usable `data-stream-url` and are skipped (~15% in the sample).
 * Stream URLs are the broadcasters' own CDNs and played with no headers
 * in the sample checked.
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

const SCRAPER_ID = "cxtv";

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

const BASE = "https://www.cxtvlive.com";
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

async function getText(url: string): Promise<string> {
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": UA } }));
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return response.text();
}

function decodeEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

/** English country name -> ISO code, built once from Node's own ICU data. */
const COUNTRY_CODES: Map<string, string> = (() => {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const map = new Map<string, string>();
    for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
            const code = String.fromCharCode(a, b);
            try {
                const name = names.of(code);
                if (name && name !== code) map.set(name.toLowerCase(), code);
            } catch {
                // not a region code
            }
        }
    }
    return map;
})();

function flagEmoji(code: string): string {
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function parseChannel(slug: string, html: string): ScrapedChannel | null {
    const url = html.match(/data-stream-url="([^"]+)"/)?.[1];
    if (!url) return null;
    const streamUrl = decodeEntities(url);
    if (!/^https?:\/\//.test(streamUrl) || /youtube\.com|youtu\.be/.test(streamUrl)) return null;

    const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || "";
    const name = decodeEntities(heading.replace(/<[^>]+>/g, " "))
        .replace(/\s+Live\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!name) return null;

    const categories = [...html.matchAll(/\/tv\/category\/[^"]+"[^>]*>([^<]+)</g)].map((m) =>
        decodeEntities(m[1] || "").trim().toLowerCase()
    );
    const countryName = decodeEntities(html.match(/\/tv\/country\/[^"]+">(?:<img[^>]*>)?([^<]+)</)?.[1] || "").trim();
    const country = COUNTRY_CODES.get(countryName.toLowerCase()) || "";
    const logo = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "";

    return {
        id: idFor(slug),
        name,
        country,
        countryName,
        countryFlag: flagEmoji(country),
        categories: [...new Set(categories.filter(Boolean))],
        languages: [],
        logo: decodeEntities(logo),
        website: `${BASE}/live-tv/${slug}`,
        network: "",
        streams: [{ url: streamUrl, quality: "", labels: [], referrer: "", userAgent: "" }]
    };
}

async function build(): Promise<ScrapedCatalogue> {
    const sitemap = await getText(`${BASE}/sitemap.xml`);
    const slugs = [
        ...new Set([...sitemap.matchAll(/<loc>https:\/\/www\.cxtvlive\.com\/live-tv\/([^<]+)<\/loc>/g)].map((m) => m[1]!))
    ];
    if (!slugs.length) throw new Error("cxtv: sitemap listed no channel pages");

    let failures = 0;
    const parsed = await mapWithConcurrency(slugs, 8, async (slug) => {
        try {
            return parseChannel(slug, await getText(`${BASE}/live-tv/${slug}`));
        } catch {
            failures++;
            return null;
        }
    });
    if (failures > slugs.length / 2) throw new Error(`cxtv: ${failures}/${slugs.length} channel pages failed`);

    const channels = parsed.filter((c): c is ScrapedChannel => c !== null);
    if (!channels.length) throw new Error("cxtv: no channel page had a direct stream URL");
    return { channels };
}

export const cxtvScraper: Scraper = {
    id: SCRAPER_ID,
    name: "CXtv",
    version: "1.0.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/cxtv.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
            console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
            console.log(`${catalogue.channels.filter((c) => c.country).length} with a country code`);
            console.log(catalogue.channels[0] || "(none)");
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
