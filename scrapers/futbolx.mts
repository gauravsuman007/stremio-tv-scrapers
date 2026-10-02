/**
 * Futbol-X (futbol-x.xyz) -- a live-sports events site that publishes its
 * own schedule as plain JSON with DIRECT stream URLs, no embed/resolve
 * step at all.
 *
 *   - `GET /api/stream` lists the categories (`football`, `tennis`,
 *     `fights`, ...).
 *   - `GET /api/<category>.json` answers `{ streams: [{ category,
 *     streams: [{ name, uri_name, poster, tag, starts_at, ends_at,
 *     always_live, streams: [{ title, url }] }] }] }` -- `url` is a
 *     static `.../<slug>/index.m3u8` on the site's own BunnyCDN/relay
 *     hosts. Some categories' files are occasionally malformed JSON and
 *     are skipped rather than failing the build.
 *
 * Streams need `Referer: https://www.futbol-x.xyz/` -- verified
 * 2026-09-30 on a `*.b-cdn.net` feed: 403 without it, 200 with it. An
 * event's feed is only up around its own kick-off, so only events that
 * haven't ended (plus any `always_live` entry) are returned, refreshed by
 * the hourly `events` task below, and all of them go in the shared
 * "Live Events" rail (see ntvst.mts/zlive.mts, which use the same
 * heading so the rails merge). `starts_at`/`ends_at` carry no zone; they
 * line up with UTC when compared against real fixtures, so they are read
 * as UTC.
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
    filter?: { countries?: string[]; categories?: string[]; genres?: string[]; languages?: string[]; sources?: string[]; market?: "home-first" | "first" };
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

const SCRAPER_ID = "futbolx";

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

const BASE = "https://www.futbol-x.xyz";
const REFERRER = `${BASE}/`;
const FALLBACK_CATEGORIES = ["football", "tennis", "basketball", "fights", "motorsports", "americanfootball", "nhl", "baseball", "rugby", "golf", "others", "wrestling", "darts"];
/** Keep an event this long after its advertised end, for overruns. */
const GRACE_MS = 60 * 60 * 1000;

interface FxEvent {
    name?: string;
    uri_name?: string;
    poster?: string;
    tag?: string;
    starts_at?: string;
    ends_at?: string;
    always_live?: number;
    streams?: Array<{ title?: string; url?: string }> | null;
}

async function getJson<T>(url: string): Promise<T> {
    const response = await withTimeout((signal) => fetch(url, { signal }));
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return (await response.json()) as T;
}

function asUtc(stamp: string | undefined): number {
    if (!stamp) return NaN;
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp}Z`);
}

async function fetchEvents(): Promise<ScrapedCatalogue> {
    const index = await getJson<{ categories?: string[] }>(`${BASE}/api/stream`).catch(() => ({ categories: FALLBACK_CATEGORIES }));
    const categories = index.categories?.length ? index.categories : FALLBACK_CATEGORIES;

    let loaded = 0;
    const now = Date.now();
    const channels: ScrapedChannel[] = [];
    const seen = new Set<string>();

    for (const category of categories) {
        let body: { streams?: Array<{ category?: string; streams?: FxEvent[] }> };
        try {
            body = await getJson(`${BASE}/api/${encodeURIComponent(category)}.json`);
            loaded++;
        } catch (cause) {
            console.error(`futbolx: ${category} skipped`, cause);
            continue;
        }

        for (const group of body.streams || []) {
            for (const event of group.streams || []) {
                if (!event.uri_name || !event.name || seen.has(event.uri_name)) continue;
                const live = Boolean(event.always_live);
                const ends = asUtc(event.ends_at);
                if (!live && !(ends + GRACE_MS > now)) continue;

                const streams: ScrapedStream[] = (event.streams || [])
                    .filter((s) => s.url && /^https?:\/\//.test(s.url))
                    .map((s) => ({
                        url: s.url!,
                        quality: s.title || "",
                        labels: live ? [] : ["Not 24/7"],
                        referrer: REFERRER,
                        userAgent: ""
                    }));
                if (!streams.length) continue;
                seen.add(event.uri_name);

                channels.push({
                    id: idFor(event.uri_name),
                    name: event.name.trim(),
                    country: "",
                    countryName: "",
                    countryFlag: "",
                    categories: ["sports", (group.category || category).toLowerCase()],
                    languages: [],
                    logo: event.poster || "",
                    website: `${BASE}/live/${event.uri_name}`,
                    network: event.tag || "",
                    streams
                });
            }
        }
    }

    if (!loaded) throw new Error("futbolx: every category file failed");
    return {
        channels,
        rails: channels.length ? [{ id: "live-events", heading: "Live Events", channelIds: channels.map((c) => c.id), group: "Live events" }] : []
    };
}

const configSchema: ScraperConfigField[] = [
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 60,
        min: 10,
        help: "How often the schedule is re-read. Events are added shortly before kick-off and dropped an hour after they end."
    }
];

/** Single-flight cache, same reasoning as ntvst.mts's. */
let eventsCache: ScrapedCatalogue | null = null;
let eventsInFlight: Promise<ScrapedCatalogue> | null = null;

function ensureEvents(): Promise<ScrapedCatalogue> {
    if (eventsCache) return Promise.resolve(eventsCache);
    if (!eventsInFlight) {
        eventsInFlight = fetchEvents()
            .then((result) => {
                eventsCache = result;
                return result;
            })
            .finally(() => {
                eventsInFlight = null;
            });
    }
    return eventsInFlight;
}

const tasks: ScraperTask[] = [
    {
        id: "events",
        label: "Refresh events",
        intervalConfigKey: "eventsIntervalMinutes",
        async run() {
            const previous = eventsCache;
            eventsCache = null;
            try {
                eventsCache = await ensureEvents();
            } catch (cause) {
                eventsCache = previous;
                throw cause;
            }
        }
    }
];

function build(): Promise<ScrapedCatalogue> {
    return ensureEvents();
}

export const futbolxScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Futbol-X",
    version: "1.0.1",
    configSchema,
    tasks,
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/futbolx.mts` -- prints a channel count and the first
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
