/**
 * TVNow (tvnow.st) -- ~175 US cable/network channels.
 *
 * `GET https://tvnow.st/api/channels` is a plain, unauthenticated JSON
 * list, and each entry's `playback` field is already the final
 * `cache0.wonvt.st/live/<id>/master.m3u8` -- no resolve step.
 *
 * The playlist AND every segment it lists (short-lived
 * `*.workers.dev/s/<expiry>/<sig>/...` URLs minted fresh on each playlist
 * fetch) need `Referer: https://tvnow.st/`; without it the playlist 403s
 * and segments 404 with `{"ok":false,"error":"not_found"}`. No particular
 * User-Agent is required. Verified 2026-09-30: playlist and a real
 * MPEG-TS segment (0x47 sync byte) fetched with only that Referer.
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

const SCRAPER_ID = "tvnow";

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

const BASE = "https://tvnow.st";

interface TvnowChannel {
    slug?: string;
    name?: string;
    category?: string;
    logo?: string;
    playback?: string;
}

async function build(): Promise<ScrapedCatalogue> {
    const response = await withTimeout((signal) => fetch(`${BASE}/api/channels`, { signal }));
    if (!response.ok) throw new Error(`tvnow: /api/channels -> ${response.status}`);
    const body = (await response.json()) as { channels?: TvnowChannel[] };

    const channels: ScrapedChannel[] = [];
    for (const entry of body.channels || []) {
        if (!entry.slug || !entry.name || !entry.playback || !/^https?:\/\//.test(entry.playback)) continue;
        channels.push({
            id: idFor(entry.slug),
            name: entry.name.trim(),
            country: "US",
            countryName: "United States",
            countryFlag: "🇺🇸",
            categories: entry.category && entry.category !== "All" ? [entry.category.toLowerCase()] : [],
            languages: ["eng"],
            logo: entry.logo ? new URL(entry.logo, BASE).href : "",
            website: "",
            network: "",
            streams: [{ url: entry.playback, quality: "", labels: [], referrer: `${BASE}/`, userAgent: "" }]
        });
    }

    if (!channels.length) throw new Error("tvnow: channel list came back empty");
    return { channels };
}

export const tvnowScraper: Scraper = {
    id: SCRAPER_ID,
    name: "TVNow (tvnow.st)",
    version: "1.0.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/tvnow.mts` -- prints a channel count and the first
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
