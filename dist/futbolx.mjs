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
/**
 * "UEFA Nations League : Scotland vs North Macedonia", "UFC 332: Silva vs Wang",
 * "Croatia vs England - UEFA Nations League" -> the sides and the competition,
 * or null when the text is not a fixture. The sides are what the host matches
 * on; the competition is only shown.
 */
function readFixture(raw) {
    const versus = /\s+(?:vs\.?|v|versus|@)\s+/i;
    let name = raw.replace(/[\u{1F1E6}-\u{1F1FF}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{1F3F4}]/gu, "").replace(/\s+/g, " ").trim();
    const first = name.search(versus);
    if (first < 0)
        return null;
    let competition = "";
    const head = name.slice(0, first);
    const cut = Math.max(head.lastIndexOf(" : "), head.lastIndexOf(": "), head.lastIndexOf(" | "));
    if (cut > 0) {
        competition = head.slice(0, cut).trim();
        name = name.slice(cut).replace(/^\s*[:|]\s*/, "").trim();
    }
    const tail = /^(.*?)(?:\s+[-\u2013|]\s+|\s+\()([^)]{3,60})\)?$/.exec(name);
    if (tail && versus.test(tail[1] || "")) {
        competition = competition || (tail[2] || "").trim();
        name = (tail[1] || "").trim();
    }
    const sides = name.split(versus).map((side) => side.trim()).filter(Boolean);
    if (sides.length < 2 || sides.length > 8)
        return null;
    if (sides.some((side) => side.length < 2 || side.length > 60 || /^(?:simulcast|tba|tbd|tbc|live|hd|fhd|uhd|sd|4k|tv|\d+)$/i.test(side)))
        return null;
    return { sides, competition };
}
/** The `event` and the display name for a card whose only fact is its title. */
function eventFor(title, extra = {}) {
    const fixture = readFixture(title);
    const competition = fixture?.competition || extra.competition || "";
    return {
        name: fixture ? fixture.sides.join(" vs ") : title,
        event: {
            ...(fixture ? { sides: fixture.sides } : { title }),
            ...(competition ? { competition } : {}),
            ...(extra.sport ? { sport: extra.sport } : {}),
            ...(extra.start && extra.start > 0 ? { start: extra.start } : {})
        }
    };
}
const SCRAPER_ID = "futbolx";
function idFor(rawId) {
    return `live:${SCRAPER_ID}:${rawId}`;
}
async function withTimeout(work, ms = 20_000) {
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
    }
    catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}
const BASE = "https://www.futbol-x.xyz";
const REFERRER = `${BASE}/`;
const FALLBACK_CATEGORIES = ["football", "tennis", "basketball", "fights", "motorsports", "americanfootball", "nhl", "baseball", "rugby", "golf", "others", "wrestling", "darts"];
/** Keep an event this long after its advertised end, for overruns. */
const GRACE_MS = 60 * 60 * 1000;
async function getJson(url) {
    const response = await withTimeout((signal) => fetch(url, { signal }));
    if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
    return (await response.json());
}
function asUtc(stamp) {
    if (!stamp)
        return NaN;
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp}Z`);
}
async function fetchEvents() {
    const index = await getJson(`${BASE}/api/stream`).catch(() => ({ categories: FALLBACK_CATEGORIES }));
    const categories = index.categories?.length ? index.categories : FALLBACK_CATEGORIES;
    let loaded = 0;
    const now = Date.now();
    const channels = [];
    const seen = new Set();
    for (const category of categories) {
        let body;
        try {
            body = await getJson(`${BASE}/api/${encodeURIComponent(category)}.json`);
            loaded++;
        }
        catch (cause) {
            console.error(`futbolx: ${category} skipped`, cause);
            continue;
        }
        for (const group of body.streams || []) {
            for (const event of group.streams || []) {
                if (!event.uri_name || !event.name || seen.has(event.uri_name))
                    continue;
                const live = Boolean(event.always_live);
                const ends = asUtc(event.ends_at);
                if (!live && !(ends + GRACE_MS > now))
                    continue;
                const streams = (event.streams || [])
                    .filter((s) => s.url && /^https?:\/\//.test(s.url))
                    .map((s) => ({
                    url: s.url,
                    quality: s.title || "",
                    labels: live ? [] : ["Not 24/7"],
                    referrer: REFERRER,
                    userAgent: ""
                }));
                if (!streams.length)
                    continue;
                seen.add(event.uri_name);
                const sport = (group.category || category).toLowerCase();
                const start = live ? 0 : asUtc(event.starts_at);
                const described = eventFor(event.name.trim(), { sport, competition: event.tag || "", start: Number.isFinite(start) ? start : 0 });
                channels.push({
                    id: idFor(event.uri_name),
                    name: described.name,
                    event: described.event,
                    country: "",
                    countryName: "",
                    countryFlag: "",
                    categories: ["sports", (group.category || category).toLowerCase()],
                    languages: [],
                    logo: event.poster || "",
                    website: `${BASE}/live/${event.uri_name}`,
                    network: described.event.competition || event.tag || "",
                    streams
                });
            }
        }
    }
    if (!loaded)
        throw new Error("futbolx: every category file failed");
    return {
        channels,
        rails: channels.length ? [{ id: "live-events", heading: "Live Events", channelIds: channels.map((c) => c.id), group: "Live events" }] : []
    };
}
const configSchema = [
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
let eventsCache = null;
let eventsInFlight = null;
function ensureEvents() {
    if (eventsCache)
        return Promise.resolve(eventsCache);
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
const tasks = [
    {
        id: "events",
        label: "Refresh events",
        intervalConfigKey: "eventsIntervalMinutes",
        async run() {
            const previous = eventsCache;
            eventsCache = null;
            try {
                eventsCache = await ensureEvents();
            }
            catch (cause) {
                eventsCache = previous;
                throw cause;
            }
        }
    }
];
function build() {
    return ensureEvents();
}
export const futbolxScraper = {
    id: SCRAPER_ID,
    name: "Futbol-X",
    version: "1.1.0",
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
