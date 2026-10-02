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
            ? [{ id: "live-now", heading: "SHOWROOM Live", channelIds: channels.map((c) => c.id), group: "SHOWROOM" }, ...railsFor(channels, SCRAPER_ID, "SHOWROOM")]
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
// Rails from this source's own data: its countries, its languages, its
// category words, and "everything on this source".
//
// The host merges rails with the same name (or the same filter) from every
// source into ONE rail, and counts a rail's channels over the whole index,
// so declaring generously is right: a country this source has one channel
// in is still a rail once other sources add theirs, and a rail that stays
// too small is simply not offered.
// -------------------------------------------------------------------------
/** Which part of the world a country is in, for the "Countries" groups. */
const CONTINENTS = [
    ["Asia", "AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE AE"],
    ["Europe", "AD AL AT BA BE BG BY CH CZ DE DK EE ES FI FO FR GB UK GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK"],
    ["Africa", "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW RE"],
    ["North America", "US CA MX GL BM"],
    ["Latin America & Caribbean", "AG AI AR AW BB BO BQ BR BS BZ CL CO CR CU CW DM DO EC GD GT GY HN HT JM KN KY LC NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI MQ GP GF"],
    ["Oceania", "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS"]
];
function continentName(code) {
    return CONTINENTS.find(([, codes]) => codes.split(" ").includes(code.toUpperCase()))?.[0] || "Elsewhere";
}
function languageTitle(code) {
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
        return name && name !== code ? name : code.toUpperCase();
    }
    catch {
        return code.toUpperCase();
    }
}
/** Words the host's own genre rails (News, Sports, Movies ...) already carry under the same name. */
const GENRE_NAMES = new Set([
    "news", "sports", "movies", "kids", "music", "documentary", "lifestyle", "business", "entertainment", "general"
]);
/** Never offered as a rail: shopping and adult shelves. */
const UNLISTED = /\b(shop\w*|xxx|adult|erotic\w*|sinnlich\w*|telesales|18\+)\b/i;
function railsFor(channels, sourceId, sourceName, wanted = { countries: true, languages: true, categories: true }) {
    const rails = [];
    const perCountry = new Map();
    const perLanguage = new Map();
    const perWord = new Map();
    for (const channel of channels) {
        if (channel.country) {
            const entry = perCountry.get(channel.country) || { n: 0, names: new Map() };
            entry.n += 1;
            if (channel.countryName)
                entry.names.set(channel.countryName, (entry.names.get(channel.countryName) || 0) + 1);
            perCountry.set(channel.country, entry);
        }
        for (const code of new Set(channel.languages))
            perLanguage.set(code, (perLanguage.get(code) || 0) + 1);
        for (const word of new Set(channel.categories))
            perWord.set(word, (perWord.get(word) || 0) + 1);
    }
    function byCount(a, b, size) {
        return size(b[1]) - size(a[1]) || a[0].localeCompare(b[0]);
    }
    if (wanted.countries) {
        for (const [code, entry] of [...perCountry.entries()].sort((a, b) => byCount(a, b, (v) => v.n))) {
            const name = [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            if (!name || !/^[A-Za-z]{2,3}$/.test(code))
                continue;
            rails.push({
                id: `country-${code.toLowerCase()}`,
                heading: `Top channels in ${name}`,
                by: "Most widely carried",
                group: `Countries/${continentName(code)}`,
                channelIds: [],
                filter: { countries: [code] }
            });
        }
    }
    if (wanted.languages) {
        for (const [code] of [...perLanguage.entries()].sort((a, b) => byCount(a, b, (v) => v))) {
            if (!/^[a-z]{2,3}$/.test(code))
                continue;
            const name = languageTitle(code);
            rails.push({
                id: `language-${code}-home`,
                heading: `${name} channels`,
                by: "In your first country",
                group: "Languages/In your first country",
                channelIds: [],
                filter: { languages: [code], market: "first" }
            });
            rails.push({
                id: `language-${code}`,
                heading: `${name} channels worldwide`,
                by: "Your countries first",
                group: "Languages/Worldwide",
                channelIds: [],
                filter: { languages: [code], market: "home-first" }
            });
        }
    }
    if (wanted.categories) {
        const taken = new Set();
        let added = 0;
        for (const [word, count] of [...perWord.entries()].sort((a, b) => byCount(a, b, (v) => v))) {
            const slug = `cat-${word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");
            if (count < 3 || word.length > 40 || GENRE_NAMES.has(word) || UNLISTED.test(word) || slug === "cat" || taken.has(slug))
                continue;
            taken.add(slug);
            rails.push({
                id: slug,
                heading: word.replace(/(^|[\s(+&/-])(\p{L})/gu, (_all, lead, first) => lead + first.toUpperCase()).replace(/\bTv\b/g, "TV"),
                by: "Its own category",
                group: "Categories",
                channelIds: [],
                filter: { categories: [word] }
            });
            added += 1;
            if (added >= 60)
                break;
        }
    }
    if (channels.length >= 4) {
        rails.push({
            id: "source",
            heading: `All of ${sourceName}`,
            by: "Every channel it carries",
            group: "Sources",
            channelIds: [],
            filter: { sources: [sourceId] }
        });
    }
    return rails;
}
export const showroomScraper = {
    id: SCRAPER_ID,
    name: "SHOWROOM",
    version: "1.2.0",
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
