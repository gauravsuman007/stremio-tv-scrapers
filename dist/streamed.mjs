/**
 * Streamed (streamed.pk and its mirrors) -- the biggest free live-sports
 * catalogue there is: every major league, boxing/UFC/PPV cards, motorsport,
 * ~150-200 events live at any hour. Also the backend behind reedstreams,
 * SportsBite, Fantastic Soda and (by way of `embed.st`) the Streamed rows of
 * crichd, so one working resolver here covers all of them.
 *
 * THE CHAIN (all verified 2026-10-03, football + PPV boxing + NFL)
 * -----------------------------------------------------------------
 *   1. `GET <api>/api/matches/live` -> `[{ id, title, category, popular,
 *      poster, teams: {home, away: {name, badge}}, sources: [{source, id}] }]`.
 *      `<api>` is `streamed.pk`, `streamed.st`... -- several of them are
 *      blocked by DNS in some countries (a German ISP's CUII list, for one),
 *      so a few mirrors are tried in turn.
 *   2. `GET <api>/api/stream/<source>/<id>` -> `[{ streamNo, language, hd,
 *      embedUrl, viewers }]`. Sources seen: `admin` (PPV), `delta`,
 *      `foxtrot`, `golf`, `hotel`...
 *   3. THE EMBED'S OWN HANDSHAKE, which is what the Rust player in
 *      `embed.st` (`lock.wasm`, ~190 KB, a wasm-bindgen module that also
 *      drives the DOM and `eval`s) does; none of that is needed:
 *        POST https://embed.st/fetch
 *          Referer: https://embed.st/embed/<source>/<id>/<n>
 *          Origin:  https://embed.st
 *          body (protobuf): 1:<source> 2:<id> 3:"<n>"   (strings)
 *      The answer is a protobuf `{1: bytes}` and a response header `goat`
 *      (32 letters, `NOSCRPS` + 25 random). The bytes are TEXT in a fixed
 *      64-symbol alphabet (`ALPHABET`, pad `T`), which decodes to
 *      `nonce[12] || ciphertext || tag[16]`; the ciphertext is **ChaCha20,
 *      key = the `goat` header as ASCII, counter starting at 1** (RFC 8439
 *      AEAD layout; the tag is not checked). Plaintext = the playlist URL:
 *      `https://lbN.strmd.st/secure/<32 random letters>/<source>/stream/<id>/<n>/playlist.m3u8`
 *      (admin's has an `rtmp/stream/<opaque>` path). Found by snapshotting
 *      the module's linear memory around the decode (the 8-char prefix of
 *      the text is the nonce's first bytes, and the plaintext sits beside
 *      the ciphertext), then confirming the key by XORing the known URL
 *      against the keystream. Alphabet recovered from five runs, no
 *      conflicts. This runs none of the site's code.
 *   4. The playlist wants `Referer: https://embed.st/` and nothing else.
 *      It is a 2-rendition master (`high/mono.m3u8` 1080p, `low/mono.m3u8`
 *      540p, relative URIs under the token path); variants are live media
 *      playlists of `https://p16-common-sign.tiktokcdn-eu.com/...image`
 *      URLs. The token is NOT single use (an earlier "403" was TLS, below).
 *   5. THE SEGMENTS ARE WEBP IMAGES (or plain TS, per source): `RIFF....WEBP`
 *      + a small VP8L stub, then the MPEG-TS -- inside an `EXIF` chunk
 *      (`admin`, ~6 MB, sync byte at file offset 42) or straight after the
 *      stub (`hotel`, offset 36); `delta` serves bare TS. A playlist is
 *      either a 2-rendition master (`admin`: `high/mono.m3u8` 1080p,
 *      `low/mono.m3u8` 540p) or a single media playlist (`delta`, `hotel`:
 *      `/m/<token>` segment URLs on the same `lbN` host). `decoders.webpexif`
 *      handles all three.
 *
 * THE CDN FINGERPRINTS TLS. `lbN.strmd.st` answers 403 to Node's default
 * TLS 1.3 ClientHello -- from `fetch`, `https.request`, with any header set,
 * any UA, ALPN or none -- and 200 to curl, ffmpeg, a browser, and **Node
 * restricted to TLS 1.2** (`maxVersion: "TLSv1.2"`), the same request. An
 * early "single-use token" theory came from a race with the browser. The
 * host therefore has to retry a 403 over TLS 1.2 (live-tv >= 1.10, in
 * `fetchvia.ts`); this scraper's own requests (the `/fetch` POST, the API)
 * need nothing special.
 *
 * Handles, not URLs: the playlist's `secure/<token>` is minted per request
 * and short-lived, so each stream's `url` is a handle
 * (`https://streamed.invalid/<source>/<id>/<n>`) resolved at play time by
 * `resolvers.streamed`. Needs live-tv >= 1.10.
 *
 * What returns nothing: a source whose embed answers `Not Found` for the
 * playlist (a listed stream that is not actually on air), `/fetch`
 * answering anything but 200, a changed alphabet/key derivation (the decoded
 * text will not start with `https://`), all of which make the resolver
 * return `null` -- never throw, never guess.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
import { createDecipheriv } from "node:crypto";
// -------------------------------------------------------------------------
// The scraper
// -------------------------------------------------------------------------
const SCRAPER_ID = "streamed";
const DECODER = "webpexif";
const RESOLVER = "streamed";
/** `live:<scraper id>:<whatever>` -- the id space every non-built-in scraper must use. */
function idFor(rawId) {
    return `live:${SCRAPER_ID}:${rawId}`;
}
/** Mirrors of the API, tried in turn (some are DNS-blocked in some countries). */
const API_BASES = ["https://streamed.pk", "https://streamed.st", "https://streamed.su"];
const EMBED = "https://embed.st";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HANDLE_HOST = "streamed.invalid";
async function withTimeout(work, ms = 15_000) {
    const controller = new AbortController();
    // Not cleared on success: the body read that follows is still tied to this signal.
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
let apiBase = API_BASES[0];
async function api(path) {
    const order = [apiBase, ...API_BASES.filter((base) => base !== apiBase)];
    let last;
    for (const base of order) {
        try {
            const response = await withTimeout((signal) => fetch(`${base}${path}`, { signal, headers: { "user-agent": BROWSER_UA, accept: "application/json" } }));
            if (!response.ok)
                throw new Error(`${base}${path} -> ${response.status}`);
            const body = (await response.json());
            apiBase = base;
            return body;
        }
        catch (cause) {
            last = cause;
        }
    }
    throw last instanceof Error ? last : new Error(String(last));
}
// ---- the embed's handshake ----------------------------------------------
/** The 64 symbols, in value order, of the text the embed answers with. Pad is `T`. */
const ALPHABET = "XYZ[\\]^_`abcdefghijklmnopqxyz{|}~!\"#$%&'()*+,-./0123GHIJKLMNOPBF";
const SYMBOL = new Map([...ALPHABET].map((char, index) => [char, index]));
function unalphabet(text) {
    const out = [];
    let acc = 0;
    let bits = 0;
    for (const char of text) {
        if (char === "T")
            break;
        const value = SYMBOL.get(char);
        if (value === undefined)
            throw new Error(`symbol ${JSON.stringify(char)} outside the alphabet`);
        acc = (acc << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
            acc &= (1 << bits) - 1;
        }
    }
    return Buffer.from(out);
}
function varint(value) {
    const out = [];
    let rest = value;
    while (rest >= 0x80) {
        out.push((rest & 0x7f) | 0x80);
        rest >>>= 7;
    }
    out.push(rest);
    return out;
}
/** protobuf: field 1 = source, 2 = id, 3 = stream number, all strings. */
function requestBody(source, id, streamNo) {
    const parts = [];
    [source, id, streamNo].forEach((value, index) => {
        const bytes = Buffer.from(value, "utf8");
        parts.push(((index + 1) << 3) | 2, ...varint(bytes.length), ...bytes);
    });
    return Buffer.from(parts);
}
/** `{1: bytes}` -> the bytes, or null. */
function field1(body) {
    if (body[0] !== 0x0a)
        return null;
    let at = 1;
    let length = 0;
    let shift = 0;
    for (;;) {
        const byte = body[at++];
        if (byte === undefined)
            return null;
        length |= (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80))
            break;
    }
    return body.subarray(at, at + length);
}
/** The `/fetch` answer -> the playlist URL, or null. */
export function decodeAnswer(body, goat) {
    const text = field1(body);
    if (!text || goat.length !== 32)
        return null;
    const raw = unalphabet(text.toString("latin1"));
    if (raw.length < 12 + 16 + 8)
        return null;
    const nonce = raw.subarray(0, 12);
    const sealed = raw.subarray(12, raw.length - 16); // the last 16 bytes are a Poly1305 tag, not checked
    const iv = Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]); // RFC 8439: block counter starts at 1
    const cipher = createDecipheriv("chacha20", Buffer.from(goat, "latin1"), iv);
    const plain = Buffer.concat([cipher.update(sealed), cipher.final()]).toString("latin1");
    return /^https:\/\/[a-z0-9.-]+\/secure\/[A-Za-z0-9/_.=~-]+\.m3u8$/.test(plain) ? plain : null;
}
/**
 * `/fetch` answers 429 beyond roughly 40 calls in a burst or ~10 a second
 * sustained (measured: 60 sequential calls 0.7 s apart, no 429), and a sweep
 * of every stream's health asks for all of them at once. A token bucket
 * (15 burst, 4 a second) keeps a viewer's press of Play from queueing behind
 * more than a moment of that, and a 429 is waited out once.
 */
const BUCKET = 15;
const REFILL_PER_SECOND = 4;
let tokens = BUCKET;
let refilledAt = Date.now();
let turn = Promise.resolve();
function takeToken() {
    const mine = turn.then(async () => {
        for (;;) {
            const now = Date.now();
            tokens = Math.min(BUCKET, tokens + ((now - refilledAt) / 1000) * REFILL_PER_SECOND);
            refilledAt = now;
            if (tokens >= 1) {
                tokens -= 1;
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.ceil(((1 - tokens) / REFILL_PER_SECOND) * 1000)));
        }
    });
    turn = mine;
    return mine;
}
async function postFetch(source, id, streamNo) {
    const once = async () => {
        await takeToken();
        return withTimeout((signal) => fetch(`${EMBED}/fetch`, {
            method: "POST",
            signal,
            headers: {
                "content-type": "application/octet-stream",
                "user-agent": BROWSER_UA,
                origin: EMBED,
                referer: `${EMBED}/embed/${encodeURIComponent(source)}/${encodeURIComponent(id)}/${encodeURIComponent(streamNo)}`
            },
            body: new Uint8Array(requestBody(source, id, streamNo))
        }));
    };
    const first = await once();
    if (first.status !== 429)
        return first;
    await first.arrayBuffer().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return once();
}
async function resolveStream(handle) {
    let url;
    try {
        url = new URL(handle);
    }
    catch {
        return null;
    }
    if (url.host !== HANDLE_HOST)
        return null;
    const [source, id, streamNo] = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (!source || !id || !streamNo)
        return null;
    const response = await postFetch(source, id, streamNo);
    const goat = response.headers.get("goat");
    if (!response.ok || !goat)
        return null;
    const playlist = decodeAnswer(Buffer.from(await response.arrayBuffer()), goat);
    if (!playlist)
        return null;
    return { url: playlist, referrer: `${EMBED}/`, userAgent: "" };
}
// ---- the segment disguise -----------------------------------------------
/** 0x47 every 188 bytes from `at`, three times over. */
function syncedAt(view, at) {
    return view[at] === 0x47 && view[at + 188] === 0x47 && view[at + 376] === 0x47;
}
/**
 * What a segment is, by source (all measured 2026-10-03):
 *   - `delta`: plain MPEG-TS, no disguise (`video/mp2t`).
 *   - `admin`: a WebP whose `EXIF` chunk holds the TS (sync byte at offset 42).
 *   - `hotel`: a WebP whose RIFF `size` field lies and whose one `VP8L` chunk
 *     is followed directly by the TS (sync byte at offset 36), no EXIF header.
 * So: TS already -> as is; otherwise walk the RIFF chunks and take the TS the
 * moment it starts, either at a sync byte or inside an `EXIF` chunk.
 */
export function unwrapSegment(segment) {
    const view = Buffer.from(segment.buffer, segment.byteOffset, segment.length);
    if (syncedAt(view, 0))
        return segment;
    if (view.length < 20 || view.toString("latin1", 0, 4) !== "RIFF" || view.toString("latin1", 8, 12) !== "WEBP") {
        throw new Error("neither MPEG-TS nor a WebP");
    }
    let at = 12;
    while (at + 8 <= view.length) {
        if (syncedAt(view, at))
            return view.subarray(at);
        const type = view.toString("latin1", at, at + 4);
        const size = view.readUInt32LE(at + 4);
        if (type === "EXIF") {
            const body = view.subarray(at + 8, Math.min(view.length, at + 8 + size));
            if (body[0] !== 0x47)
                throw new Error("EXIF chunk is not MPEG-TS");
            return body;
        }
        at += 8 + size + (size & 1);
    }
    throw new Error("no MPEG-TS inside the WebP");
}
const CATEGORY_LABELS = {
    football: "Football",
    basketball: "Basketball",
    "american-football": "American Football",
    hockey: "Hockey",
    baseball: "Baseball",
    tennis: "Tennis",
    motor_sports: "Motorsport",
    "motor-sports": "Motorsport",
    fight: "Fighting",
    rugby: "Rugby",
    cricket: "Cricket",
    golf: "Golf",
    darts: "Darts",
    billiards: "Billiards",
    afl: "AFL",
    other: "Other sports"
};
function labelOf(category) {
    return CATEGORY_LABELS[category] || category.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function badge(id) {
    return id ? `${apiBase}/api/images/badge/${id}.webp` : "";
}
/** Run `work` over `items`, `size` at a time. */
async function pooled(items, size, work) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            out[index] = await work(items[index]);
        }
    }));
    return out;
}
async function fetchEvents() {
    const matches = await api("/api/matches/live");
    const lists = await pooled(matches, 8, async (match) => {
        const found = [];
        for (const source of match.sources || []) {
            try {
                found.push(...(await api(`/api/stream/${encodeURIComponent(source.source)}/${encodeURIComponent(source.id)}`)));
            }
            catch {
                /* that source is skipped, the match keeps the others */
            }
        }
        return found;
    });
    const channels = [];
    const byCategory = new Map();
    matches.forEach((match, index) => {
        const streams = (lists[index] || [])
            .sort((a, b) => Number(b.hd) - Number(a.hd) || (b.viewers || 0) - (a.viewers || 0))
            .map((stream) => ({
            url: `https://${HANDLE_HOST}/${encodeURIComponent(stream.source)}/${encodeURIComponent(stream.id)}/${stream.streamNo}`,
            quality: `${stream.hd ? "HD" : "SD"}${stream.language ? ` · ${stream.language}` : ""}`,
            labels: [],
            referrer: `${EMBED}/`,
            userAgent: "",
            resolver: RESOLVER,
            decoder: DECODER
        }));
        if (!streams.length)
            return;
        const home = badge(match.teams?.home?.badge);
        const away = badge(match.teams?.away?.badge);
        const poster = match.poster ? `${apiBase}${match.poster}` : "";
        const category = match.category || "other";
        const id = idFor(match.id);
        const homeName = match.teams?.home?.name?.trim() || "";
        const awayName = match.teams?.away?.name?.trim() || "";
        const sides = homeName && awayName ? [homeName, awayName] : [];
        channels.push({
            id,
            name: sides.length ? sides.join(" vs ") : match.title.trim(),
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", category],
            languages: [],
            logo: home || poster,
            ...(home && away ? { logos: [home, away] } : {}),
            // Who and when, so the host merges this with the same fixture from other sources.
            event: {
                ...(sides.length ? { sides } : { title: match.title.trim() }),
                sport: category,
                ...(match.date && match.date > 0 ? { start: match.date } : {})
            },
            website: `${apiBase}/watch/${match.id}`,
            network: "",
            streams
        });
        byCategory.set(category, [...(byCategory.get(category) || []), id]);
    });
    if (!matches.length)
        throw new Error("streamed: the live list is empty");
    const rails = channels.length
        ? [
            { id: "live-events", heading: "Live Events", channelIds: channels.map((channel) => channel.id), group: "Live events" },
            ...[...byCategory.entries()]
                .filter(([, ids]) => ids.length)
                .map(([category, ids]) => ({ id: `live-${category.replace(/[^a-z0-9-]/g, "-").slice(0, 30)}`, heading: `Live ${labelOf(category)}`, channelIds: ids, group: "Live events" }))
        ]
        : [];
    return { channels, rails };
}
const configSchema = [
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 20,
        min: 5,
        help: "How often the list of live events is re-read. Each event's streams are resolved when someone plays them, not here."
    }
];
/** Single-flight cache, same reasoning as futbolx.mts's. */
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
        label: "Refresh live events",
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
export const streamedScraper = {
    id: SCRAPER_ID,
    name: "Streamed",
    version: "1.1.0",
    configSchema,
    tasks,
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    resolvers: { [RESOLVER]: resolveStream },
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/streamed.mts` -- prints a channel count, the first
// channel found, and resolves its first stream.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then(async (catalogue) => {
        console.log(`${catalogue.channels.length} channels, rails: ${(catalogue.rails || []).map((rail) => `${rail.heading}(${rail.channelIds.length})`).join(", ")}`);
        const first = catalogue.channels[0];
        console.log(first || "(none)");
        if (first?.streams[0])
            console.log(await resolveStream(first.streams[0].url));
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
