/**
 * DaddyLive (dlhd.st, currently served from dlive.sx) -- about 900 24/7
 * channels and a daily sports schedule, all on ONE backend whose video
 * arrives disguised as PNG images. This is the first scraper here that
 * needs the scraper contract's segment `decoders`; it was rejected before
 * that existed (see SOURCES.md and ntvst.mts's old `dlhd` note).
 *
 * THE CHANNELS
 *   `/24-7-channels.php` is a plain list of `<a href="/watch.php?id=N">`
 *   cards, the channel's name in `.card__title`. Every channel's player
 *   (`daddyliveplayer.st/premiumtv/daddy.php?id=N`, ~650KB of HTML) holds
 *   one line that matters, `const SRC = "https://edge.<host>/premiumN/
 *   index.m3u8"`, and the edge host is the same for every id (verified
 *   2026-10-01 across ids, with and without a Referer, which it does not
 *   need). So ONE player page is fetched per build to learn the current
 *   edge host, and every channel's URL is built from it -- 900 fetches of
 *   650KB each would be half a gigabyte to learn the same hostname 900
 *   times. The edge host rotates now and then; the twelve-hourly rebuild
 *   picks the new one up.
 *
 *   Names carry their country as a trailing word ("ABC USA", "Star Sports
 *   1 IN", "Canal+ Sport Poland"). That word is moved into `country`, so
 *   "ABC" + US merges with iptv-org's ABC instead of sitting beside it as
 *   a second card. Names with no country word keep `country` empty.
 *
 * THE EVENTS
 *   The home page's `#schedule` lists today's events (UK time), each with
 *   the channel ids carrying it -- often event-only ids above the 24/7
 *   range. Every event starting between three hours ago and two hours from
 *   now becomes one card on the shared "Live Events" rail (same heading as
 *   ntvst/zlive/futbolx, so the rails merge), refreshed hourly by the
 *   `events` task.
 *
 * THE DISGUISE (the `tiktikpx` decoder)
 *   The playlist itself is ordinary HLS. Each segment it lists is a real
 *   PNG on a TikTok image CDN. Decoded exactly as daddyliveplayer.st's own
 *   `unwrap()`/`pngRGB()` do (plain JS, no WASM, no anti-tamper): inflate
 *   the PNG's IDAT stream, undo the per-row PNG filters into RGB, and the
 *   first eight bytes of pixel data read `TIKTIKPX`; the next four are a
 *   big-endian length, followed by that many bytes of gzip whose contents
 *   are the MPEG-TS. The player also accepts two older layouts (TS after
 *   IEND, TS in a WebP EXIF chunk) and raw/`TIKTIKRAW`/`TIKTIKTSGZ`-tagged
 *   bodies; all are handled here too, because the site switches between
 *   them without notice. Verified 2026-10-01 on a live segment: 1.43MB
 *   PNG in, 1.51MB of TS out, sync byte on every 188-byte packet.
 *
 *   The decoding runs inside stremio-tv's Live TV plugin, on every segment,
 *   via its relay (plugin API 1.2.0+). On an older stremio-tv these
 *   streams are dropped there rather than offered -- see the template.
 */
import { gunzipSync, inflateSync } from "node:zlib";
const SCRAPER_ID = "dlhd";
function idFor(rawId) {
    return `live:${SCRAPER_ID}:${rawId}`;
}
async function withTimeout(work, ms = 20_000) {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: `fetch()` resolves on
    // headers, and the body read that follows is still tied to this
    // signal -- clearing the timer here would leave a stalled body able to
    // hang build() forever. `unref()` keeps the timer from holding the
    // process open.
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
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
//: dlhd.st redirects here; tried in order, so a domain move costs one
//: failed request rather than the whole build.
const SITES = ["https://dlhd.st", "https://dlive.sx"];
const PLAYER = "https://daddyliveplayer.st/premiumtv/daddy.php?id=";
const DECODER = "tiktikpx";
async function getText(url, referrer = "") {
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(referrer ? { Referer: referrer } : {}) } }));
    if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
    return { text: await response.text(), url: response.url };
}
async function fromSite(path) {
    let last = null;
    for (const site of SITES) {
        try {
            const got = await getText(`${site}${path}`);
            return { text: got.text, base: new URL(got.url).origin };
        }
        catch (cause) {
            last = cause;
        }
    }
    throw last instanceof Error ? last : new Error(`dlhd: ${path} unreachable`);
}
function decodeEntities(text) {
    return text
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}
/** A trailing word in a channel name, as the site writes it, and the
 *  country it means. iptv-org's codes, so "UK" not "GB". */
const COUNTRY_WORDS = {
    USA: ["US", "United States"],
    US: ["US", "United States"],
    UK: ["UK", "United Kingdom"],
    Poland: ["PL", "Poland"],
    Italy: ["IT", "Italy"],
    France: ["FR", "France"],
    CZ: ["CZ", "Czechia"],
    DE: ["DE", "Germany"],
    Germany: ["DE", "Germany"],
    Spain: ["ES", "Spain"],
    Portugal: ["PT", "Portugal"],
    Israel: ["IL", "Israel"],
    Bulgaria: ["BG", "Bulgaria"],
    SK: ["SK", "Slovakia"],
    Denmark: ["DK", "Denmark"],
    Serbia: ["RS", "Serbia"],
    MX: ["MX", "Mexico"],
    Mexico: ["MX", "Mexico"],
    Greece: ["GR", "Greece"],
    Croatia: ["HR", "Croatia"],
    Turkey: ["TR", "Turkey"],
    NL: ["NL", "Netherlands"],
    Netherland: ["NL", "Netherlands"],
    Netherlands: ["NL", "Netherlands"],
    Brasil: ["BR", "Brazil"],
    Brazil: ["BR", "Brazil"],
    CA: ["CA", "Canada"],
    Canada: ["CA", "Canada"],
    NZ: ["NZ", "New Zealand"],
    Argentina: ["AR", "Argentina"],
    Romania: ["RO", "Romania"],
    Cyprus: ["CY", "Cyprus"],
    UAE: ["AE", "United Arab Emirates"],
    AU: ["AU", "Australia"],
    Australia: ["AU", "Australia"],
    Russia: ["RU", "Russia"],
    Malaysia: ["MY", "Malaysia"],
    Sweden: ["SE", "Sweden"],
    PK: ["PK", "Pakistan"],
    Norway: ["NO", "Norway"],
    IN: ["IN", "India"],
    India: ["IN", "India"],
    Ireland: ["IE", "Ireland"],
    Belgium: ["BE", "Belgium"],
    Austria: ["AT", "Austria"],
    Hungary: ["HU", "Hungary"],
    Slovenia: ["SI", "Slovenia"],
    Finland: ["FI", "Finland"],
    Chile: ["CL", "Chile"],
    Colombia: ["CO", "Colombia"],
    Peru: ["PE", "Peru"],
    SA: ["ZA", "South Africa"],
    Qatar: ["QA", "Qatar"]
};
function flagOf(code) {
    const iso = code === "UK" ? "GB" : code;
    if (!/^[A-Z]{2}$/.test(iso))
        return "";
    return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
/** "Star Sports 1 IN" -> name "Star Sports 1", country IN. */
function splitCountry(raw) {
    const match = /^(.*\S)\s+\(?([A-Za-z]+)\)?$/.exec(raw);
    const word = match?.[2];
    const known = word ? COUNTRY_WORDS[word] : undefined;
    if (match && known)
        return { name: match[1], country: known[0], countryName: known[1] };
    return { name: raw, country: "", countryName: "" };
}
/** Categories from the name alone -- this site gives none. Unrecognised
 *  is fine: the plugin files it under General. */
function categoriesOf(name) {
    const n = name.toLowerCase();
    const out = [];
    if (/sport|espn|bein|dazn|tnt sports|eurosport|golf|nba|nfl|nhl|mlb|tennis|cricket|racing|f1|motor|fight|wwe|ufc|fox soccer|premier|laliga|ligue|bundesliga|sky sports|arena|eleven|polsat sport|canal\+ sport|setanta|supersport|sportsnet|tsn/.test(n))
        out.push("sports");
    if (/\bnews\b|cnn|msnbc|cnbc|bloomberg|fox business|sky news|al jazeera|euronews/.test(n))
        out.push("news");
    if (/cartoon|nick|disney|boomerang|baby|kids|junior|jr\b/.test(n))
        out.push("kids");
    if (/movie|cinema|film|hbo|starz|showtime|cinemax|mgm|amc|tcm|paramount|epix/.test(n))
        out.push("movies");
    if (/music|mtv|vh1|bet\b/.test(n) && !out.includes("kids"))
        out.push("music");
    if (/discovery|history|national geographic|nat geo|animal planet|science|documentary|smithsonian/.test(n))
        out.push("documentary");
    return out;
}
/** The current edge host, learnt from one channel's player page. */
async function edgeBase(probeId, site) {
    const { text } = await getText(`${PLAYER}${encodeURIComponent(probeId)}`, `${site}/`);
    const src = /SRC\s*=\s*"(https:\/\/[^"]+?)\/premium\d+\/index\.m3u8"/.exec(text)?.[1];
    if (!src)
        throw new Error("dlhd: the player page no longer names an edge host");
    return src;
}
function streamFor(edge, id, labels = []) {
    return { url: `${edge}/premium${id}/index.m3u8`, quality: "", labels, referrer: "", userAgent: "", decoder: DECODER };
}
async function fetchChannels() {
    const { text, base } = await fromSite("/24-7-channels.php");
    const cards = [...text.matchAll(/href="\/watch\.php\?id=(\d+)"[\s\S]*?card__title">([^<]*)</g)];
    if (!cards.length)
        throw new Error("dlhd: no channels found on the 24/7 page");
    const edge = await edgeBase(cards[0][1], base);
    const channels = [];
    const seen = new Set();
    for (const card of cards) {
        const id = card[1];
        const raw = decodeEntities(card[2]);
        if (!raw || seen.has(id))
            continue;
        seen.add(id);
        const { name, country, countryName } = splitCountry(raw);
        channels.push({
            id: idFor(id),
            name,
            country,
            countryName,
            countryFlag: flagOf(country),
            categories: categoriesOf(raw),
            languages: [],
            logo: "",
            website: `${base}/watch.php?id=${id}`,
            network: "",
            streams: [streamFor(edge, id)]
        });
    }
    return { channels, edge, base };
}
/** UK wall-clock HH:MM today, as an instant. The schedule is "UK GMT",
 *  which in summer means BST -- Intl gives the real offset either way. */
function ukTimeToday(hhmm, now) {
    const [h, m] = hhmm.split(":").map(Number);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const londonNowAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    const offset = londonNowAsUtc - Math.floor(now.getTime() / 60_000) * 60_000;
    return Date.UTC(get("year"), get("month") - 1, get("day"), h || 0, m || 0) - offset;
}
const BEFORE_MS = 2 * 60 * 60 * 1000;
const AFTER_MS = 3 * 60 * 60 * 1000;
async function fetchEvents(edge) {
    const { text, base } = await fromSite("/");
    const at = text.indexOf('id="schedule"');
    if (at < 0)
        return [];
    const schedule = text.slice(at);
    const now = new Date();
    const events = [];
    let category = "";
    /*
        Walked as a token stream rather than a nested parse: a category
        header, then events, each event a time, a title and channel links.
        Only the FIRST day block is today's; later days are skipped by the
        `schedule__dayTitle` check.
    */
    const tokens = schedule.matchAll(/schedule__dayTitle">([^<]*)<|card__meta">([^<]*)<|schedule__time" data-time="(\d\d:\d\d)"|schedule__eventTitle">([^<]*)<|watch\.php\?id=(\d+)" title="([^"]*)"/g);
    let days = 0;
    let current = null;
    const finish = () => {
        if (!current || !current.ids.length)
            return;
        // "Upcoming Events" is a list of future fixtures, days or weeks
        // out, each pinned to a placeholder time today -- not live.
        if (/upcoming/i.test(category))
            return;
        const start = ukTimeToday(current.time, now);
        if (start - BEFORE_MS > now.getTime() || start + AFTER_MS < now.getTime())
            return;
        const title = decodeEntities(current.title).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
        if (!title)
            return;
        const upcoming = start > now.getTime();
        events.push({
            id: idFor(`event-${current.time.replace(":", "")}-${current.ids.join("-")}`),
            name: title,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", category.split(/\s{2,}| - /)[0].trim().toLowerCase().replace(/^all\s+|\s+events$/g, "")].filter(Boolean),
            languages: [],
            logo: "",
            website: base,
            network: current.names.join(", "),
            streams: current.ids.map((id) => streamFor(edge, id, upcoming ? [`Starts ${current.time} UK`] : []))
        });
    };
    for (const token of tokens) {
        if (token[1] !== undefined) {
            days += 1;
            if (days > 1)
                break;
        }
        else if (token[2] !== undefined) {
            finish();
            current = null;
            category = decodeEntities(token[2]).replace(/[^\p{L}\p{N} ()&'+-]/gu, "").trim();
        }
        else if (token[3] !== undefined) {
            finish();
            current = { time: token[3], title: "", ids: [], names: [] };
        }
        else if (token[4] !== undefined && current) {
            current.title = token[4];
        }
        else if (token[5] !== undefined && current && !current.ids.includes(token[5])) {
            current.ids.push(token[5]);
            current.names.push(decodeEntities(token[6] || ""));
        }
    }
    finish();
    return events;
}
// --- the decoder -----------------------------------------------------------
const TPIX = [84, 73, 75, 84, 73, 75, 80, 88]; // "TIKTIKPX"
const TRAW = [84, 73, 75, 84, 73, 75, 82, 65, 87]; // "TIKTIKRAW"
const TSGZ = [84, 73, 75, 84, 73, 75, 84, 83, 71, 90]; // "TIKTIKTSGZ"
function isTs(bytes, at = 0) {
    return bytes[at] === 0x47 && (at + 188 >= bytes.length || bytes[at + 188] === 0x47);
}
function find(bytes, tag) {
    outer: for (let i = 0; i + tag.length < bytes.length; i++) {
        for (let j = 0; j < tag.length; j++)
            if (bytes[i + j] !== tag[j])
                continue outer;
        return i;
    }
    return -1;
}
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc)
        return a;
    return pb <= pc ? b : c;
}
/** PNG -> its pixels as packed RGB, or null for any PNG this cannot be
 *  (not 8-bit, interlaced, not RGB/RGBA). */
function pngRgb(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let interlace = 0;
    const idat = [];
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12)
            return null;
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        const data = bytes.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") {
            width = view.getUint32(off + 8);
            height = view.getUint32(off + 12);
            depth = data[8];
            colour = data[9];
            interlace = data[12];
        }
        else if (type === "IDAT") {
            idat.push(data);
        }
        else if (type === "IEND") {
            break;
        }
        off += 12 + len;
    }
    if (!width || !height || depth !== 8 || interlace || (colour !== 2 && colour !== 6))
        return null;
    const raw = inflateSync(Buffer.concat(idat));
    const bpp = colour === 6 ? 4 : 3;
    const stride = width * bpp;
    const rgb = new Uint8Array(width * height * 3);
    let src = 0;
    let dst = 0;
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        if (src + 1 + stride > raw.length)
            return null;
        const filter = raw[src++];
        const row = raw.subarray(src, src + stride);
        src += stride;
        const out = new Uint8Array(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            let v = row[i];
            if (filter === 1)
                v += a;
            else if (filter === 2)
                v += b;
            else if (filter === 3)
                v += (a + b) >> 1;
            else if (filter === 4)
                v += paeth(a, b, c);
            else if (filter !== 0)
                return null;
            out[i] = v & 255;
        }
        if (colour === 2) {
            rgb.set(out, dst);
            dst += stride;
        }
        else {
            for (let i = 0; i < stride; i += 4) {
                rgb[dst++] = out[i];
                rgb[dst++] = out[i + 1];
                rgb[dst++] = out[i + 2];
            }
        }
        prev = out;
    }
    return rgb;
}
/** The newest layout: TS gzipped into the pixels, behind "TIKTIKPX". */
function fromPixels(bytes) {
    const rgb = pngRgb(bytes);
    if (!rgb || rgb.length < 12)
        return null;
    for (let k = 0; k < TPIX.length; k++)
        if (rgb[k] !== TPIX[k])
            return null;
    const size = new DataView(rgb.buffer, rgb.byteOffset + 8, 4).getUint32(0);
    if (size <= 0 || 12 + size > rgb.length)
        return null;
    const ts = gunzipSync(rgb.subarray(12, 12 + size));
    return isTs(ts) ? new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength) : null;
}
/** An older layout: TS appended after the PNG's IEND chunk. */
function afterIend(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12)
            return null;
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        off += 12 + len;
        if (type === "IEND")
            return off < bytes.length && isTs(bytes, off) ? bytes.subarray(off) : null;
    }
    return null;
}
/** An older layout still: TS in a WebP's EXIF chunk. */
function webpExif(bytes) {
    const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    if (bytes.length < 16 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP")
        return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 12;
    while (off + 8 <= bytes.length) {
        const tag = ascii(off, 4);
        const n = view.getUint32(off + 4, true);
        off += 8;
        if (off + n > bytes.length)
            return null;
        if (tag === "EXIF") {
            const data = bytes.subarray(off, off + n);
            return data.length > 188 && isTs(data) ? data : null;
        }
        off += n + (n & 1);
    }
    return null;
}
/** Exported for the standalone check below; the plugin calls it through
 *  `decoders.tiktikpx`. */
export function unwrapSegment(bytes) {
    if (isTs(bytes))
        return bytes;
    const webp = webpExif(bytes);
    if (webp)
        return webp;
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
        const tail = afterIend(bytes);
        if (tail)
            return tail;
        const pixels = fromPixels(bytes);
        if (pixels)
            return pixels;
        throw new Error("dlhd: PNG segment with no TS payload");
    }
    const raw = find(bytes, TRAW);
    if (raw >= 0 && isTs(bytes, raw + TRAW.length))
        return bytes.subarray(raw + TRAW.length);
    const gz = find(bytes, TSGZ);
    if (gz >= 0) {
        const ts = gunzipSync(bytes.subarray(gz + TSGZ.length));
        return new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength);
    }
    for (let i = 0; i + 188 < bytes.length; i++)
        if (isTs(bytes, i))
            return bytes.subarray(i);
    throw new Error("dlhd: segment with no TS payload");
}
// --- tasks, caches and build() ------------------------------------------------
const configSchema = [
    {
        key: "channelsIntervalMinutes",
        label: "Channel list refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 60,
        help: "How often the 24/7 channel list (and the current video edge host) is re-read."
    },
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 60,
        min: 10,
        help: "How often today's schedule is re-read for the Live Events rail."
    }
];
/** Single-flight caches, same reasoning as ntvst.mts's. */
let channelsCache = null;
let channelsInFlight = null;
let eventsCache = null;
let eventsInFlight = null;
function ensureChannels() {
    if (channelsCache)
        return Promise.resolve(channelsCache);
    if (!channelsInFlight) {
        channelsInFlight = fetchChannels()
            .then((result) => (channelsCache = result))
            .finally(() => {
            channelsInFlight = null;
        });
    }
    return channelsInFlight;
}
function ensureEvents() {
    if (eventsCache)
        return Promise.resolve(eventsCache);
    if (!eventsInFlight) {
        eventsInFlight = ensureChannels()
            .then(({ edge }) => fetchEvents(edge))
            .then((result) => (eventsCache = result))
            .finally(() => {
            eventsInFlight = null;
        });
    }
    return eventsInFlight;
}
async function refresh(clear, restore, ensure) {
    clear();
    try {
        await ensure();
    }
    catch (cause) {
        restore();
        throw cause;
    }
}
const tasks = [
    {
        id: "channels",
        label: "Refresh channels",
        intervalConfigKey: "channelsIntervalMinutes",
        async run() {
            const previous = channelsCache;
            await refresh(() => (channelsCache = null), () => (channelsCache = previous), ensureChannels);
        }
    },
    {
        id: "events",
        label: "Refresh events",
        dependsOn: ["channels"],
        intervalConfigKey: "eventsIntervalMinutes",
        async run() {
            const previous = eventsCache;
            await refresh(() => (eventsCache = null), () => (eventsCache = previous), ensureEvents);
        }
    }
];
async function build() {
    const { channels } = await ensureChannels();
    // Events failing must not cost the 900 channels.
    const events = await ensureEvents().catch((cause) => {
        console.error("dlhd: events skipped", cause);
        return [];
    });
    return {
        channels: [...channels, ...events],
        rails: events.length ? [{ id: "live-events", heading: "Live Events", channelIds: events.map((e) => e.id) }] : []
    };
}
export const dlhdScraper = {
    id: SCRAPER_ID,
    name: "DaddyLive",
    version: "1.0.0",
    configSchema,
    tasks,
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/dlhd.mts` -- prints a channel count and the first
// channel, then fetches that channel's playlist and first segment and
// decodes it, so a change in the disguise shows up here, not on a sofa.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const catalogue = await build();
        const events = catalogue.rails?.[0]?.channelIds.length || 0;
        console.log(`${catalogue.channels.length} channels (${events} live events), ${(catalogue.rails || []).length} rails`);
        console.log(catalogue.channels[0] || "(none)");
        const url = catalogue.channels[0]?.streams[0]?.url;
        if (!url)
            return;
        const playlist = await (await fetch(url)).text();
        const segmentUrl = playlist.split("\n").find((line) => /^https?:/.test(line.trim()));
        if (!segmentUrl)
            throw new Error(`no segment in ${url}`);
        const segment = new Uint8Array(await (await fetch(segmentUrl.trim())).arrayBuffer());
        const ts = unwrapSegment(segment);
        console.log(`segment: ${segment.length} bytes in, ${ts.length} bytes of TS out, sync ${ts[0] === 0x47 && ts[188] === 0x47}`);
    })().catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
