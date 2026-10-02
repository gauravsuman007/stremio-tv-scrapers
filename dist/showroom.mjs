/**
 * SHOWROOM (showroom-live.com) -- a Japanese idol/talent live-streaming
 * platform. Not 24/7 channels: each "channel" here is a streamer's ROOM
 * that is live right now, typically for an hour or two. Usually 40-60
 * rooms are live at once.
 *
 * `GET https://www.showroom-live.com/api/live/onlives` is public and
 * unauthenticated. It groups live rooms by genre (`onlives[].genre_name`
 * -- the same room appears under several genres, e.g. "Popularity" and
 * "Music") and each room entry already carries `streaming_url_list`, whose
 * `type: "hls"` entries are plain `.m3u8` URLs on `*.showroom-txlive.com`
 * that play with no headers (verified 2026-09-30). Placeholder entries
 * (`{ cell_type, message: "Currently, there are no live performance." }`)
 * have no `room_id` and are skipped. Premium (paid) rooms are skipped.
 *
 * WHY A TASK: a room's stream URL is only valid while that room is live,
 * so the host's twelve-hourly rebuild alone would serve mostly dead
 * entries. The `rooms` task below re-fetches the list on its own, much
 * shorter interval (default 30 minutes), into a cache `build()` reads
 * from -- the same pattern as `ntvst.mts`'s events task. Zero live rooms
 * is a legitimate answer (returned as an empty catalogue); only a failed
 * fetch throws.
 *
 * Channel ids are keyed by `room_url_key` (stable per room) so favourites
 * survive between broadcasts. All rooms are also offered as one rail,
 * "SHOWROOM Live".
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
const SCRAPER_ID = "showroom";
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
const API = "https://www.showroom-live.com/api/live/onlives";
/** Genres that are rankings/filters rather than a kind of content. */
const NON_CATEGORY_GENRES = new Set(["popularity", "new30day", "newcomer"]);
async function fetchRooms() {
    const response = await withTimeout((signal) => fetch(API, { signal, headers: { "Accept-Language": "en-US,en;q=0.9" } }));
    if (!response.ok)
        throw new Error(`showroom: onlives -> ${response.status}`);
    const body = (await response.json());
    if (!Array.isArray(body.onlives))
        throw new Error("showroom: onlives missing from response");
    const byRoom = new Map();
    for (const genre of body.onlives) {
        const category = (genre.genre_name || "").toLowerCase();
        for (const live of genre.lives || []) {
            if (!live.room_id || !live.room_url_key || !live.main_name || live.premium_room_type)
                continue;
            const existing = byRoom.get(live.room_id);
            if (existing) {
                if (category && !NON_CATEGORY_GENRES.has(category) && !existing.categories.includes(category)) {
                    existing.categories.push(category);
                }
                continue;
            }
            const streams = (live.streaming_url_list || [])
                .filter((s) => s.type === "hls" && s.url && /^https?:\/\//.test(s.url))
                .sort((a, b) => (b.quality || 0) - (a.quality || 0))
                .map((s) => ({ url: s.url, quality: s.label || "", labels: ["Not 24/7"], referrer: "", userAgent: "" }));
            if (!streams.length)
                continue;
            byRoom.set(live.room_id, {
                id: idFor(live.room_url_key),
                name: live.main_name.trim(),
                country: "JP",
                countryName: "Japan",
                countryFlag: "🇯🇵",
                categories: category && !NON_CATEGORY_GENRES.has(category) ? [category] : [],
                languages: ["jpn"],
                logo: live.image_square || live.image || "",
                website: `https://www.showroom-live.com/r/${live.room_url_key}`,
                network: "SHOWROOM",
                streams
            });
        }
    }
    const channels = [...byRoom.values()];
    return {
        channels,
        rails: channels.length
            ? [{ id: "live-now", heading: "SHOWROOM Live", channelIds: channels.map((c) => c.id), group: "SHOWROOM" }, ...categoryRails(channels, "SHOWROOM")]
            : []
    };
}
const configSchema = [
    {
        key: "roomsIntervalMinutes",
        label: "Live rooms refresh interval (minutes)",
        type: "number",
        default: 30,
        min: 5,
        help: "How often the list of rooms live right now is re-fetched. Rooms go live and offline all day, and a room's stream URL stops working when it does."
    }
];
/** Single-flight cache, same reasoning as ntvst.mts's: the host's own
 *  build() calls and this scraper's task are not serialized. */
let roomsCache = null;
let roomsInFlight = null;
function ensureRooms() {
    if (roomsCache)
        return Promise.resolve(roomsCache);
    if (!roomsInFlight) {
        roomsInFlight = fetchRooms()
            .then((result) => {
            roomsCache = result;
            return result;
        })
            .finally(() => {
            roomsInFlight = null;
        });
    }
    return roomsInFlight;
}
const tasks = [
    {
        id: "rooms",
        label: "Refresh live rooms",
        intervalConfigKey: "roomsIntervalMinutes",
        async run() {
            const previous = roomsCache;
            roomsCache = null;
            try {
                roomsCache = await ensureRooms();
            }
            catch (cause) {
                roomsCache = previous;
                throw cause;
            }
        }
    }
];
function build() {
    return ensureRooms();
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
function categoryRails(channels, sourceName, min = 5, cap = 30) {
    const counts = new Map();
    for (const channel of channels) {
        for (const word of new Set(channel.categories))
            counts.set(word, (counts.get(word) || 0) + 1);
    }
    const taken = new Set();
    const rails = [];
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [word, count] of ranked) {
        const slug = `cat-${word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");
        if (count < min || word.length > 40 || GENRE_WORDS.has(word) || UNLISTED.test(word) || slug === "cat" || taken.has(slug))
            continue;
        taken.add(slug);
        rails.push({
            id: slug,
            heading: word.replace(/(^|[\s(+&/-])(\p{L})/gu, (_all, lead, first) => lead + first.toUpperCase()).replace(/\bTv\b/g, "TV"),
            by: `From ${sourceName}`,
            channelIds: [],
            filter: { categories: [word] },
            group: `Categories/${sourceName.replace(/\//g, " ")}`
        });
        if (rails.length >= cap)
            break;
    }
    return rails;
}
export const showroomScraper = {
    id: SCRAPER_ID,
    name: "SHOWROOM",
    version: "1.1.0",
    configSchema,
    tasks,
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/showroom.mts` -- prints a channel count and the first
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
