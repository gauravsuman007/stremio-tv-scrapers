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
    return { channels, rails: categoryRails(channels, "TVNow") };
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

export const tvnowScraper: Scraper = {
    id: SCRAPER_ID,
    name: "TVNow (tvnow.st)",
    version: "1.1.0",
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
