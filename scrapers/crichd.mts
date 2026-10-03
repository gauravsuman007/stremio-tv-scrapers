/**
 * CricHD (crichd.at) -- live cricket matches, each with the TV channels
 * carrying it. The site is a thin, server-rendered front over other
 * people's embeds, so most of the work here is following those embeds to a
 * playlist.
 *
 * THE EVENTS
 *   The home page lists every match/series as `<a href="/events/<slug>">`
 *   under a league heading, each with a `data-start` / `data-end` pair (UTC,
 *   ISO). Only the status TEXT is rewritten client-side; the timestamps are
 *   in the HTML, so "live" is decided here: from ten minutes before the
 *   start to the end. Every live event becomes ONE card, named as the event
 *   page's own title ("India vs West Indies", "Asian Games T20"), on TWO
 *   rails with identical content:
 *
 *     - "Live Events"  -- the heading ntvst/zlive/dlhd/futbolx also use, so
 *       the host merges them into one rail and one card per fixture;
 *     - "Live Cricket" -- the same heading ntvst gives its cricket rail, so
 *       it merges with theirs too.
 *
 *   The event page (`/events/<slug>`) is a table: Streamer ("Link 1"),
 *   Channel ("Willow Cricket HD"), Mobile, Quality, Ads, Language, and a
 *   "Watch" link of the form `hitsportshdd.xyz/fr.php?src=<embed url>`. Each
 *   row becomes one source on the event card. The channel's own name,
 *   language and quality are kept on the stream (`labels`, `quality`);
 *   language also goes on the card as an ISO 639-3 code.
 *
 *   The "Quality" column read 1500 on every row seen (10 rows, 2 events,
 *   2026-10-03), next to "Ads: 3" on every row -- constants, not
 *   resolutions. It is treated as a bitrate in kbps and shown only when the
 *   channel's name says nothing better ("HD", "720p", "1080p", "4K").
 *
 *   THE GRAPHIC: the event page draws both sides (`<img alt="India Logo">`
 *   over the name, then the status, then the other side), so a match card
 *   gives `logos = [side 1, side 2]` for the host to draw side by side
 *   (`ScrapedChannel.logos`), `logo` being side 1 for a host that predates it.
 *   A tournament page ("Asian Games T20") has the tournament as side 1 and the
 *   placeholder "Live" as side 2: no pair, the league's picture is `logo`.
 *
 * THE EMBEDS (what the "Watch" link points at, and which are supported)
 *   Verified 2026-10-03, all with plain HTTP, no browser:
 *
 *   dlhd     `daddylive1.cx/my/stream-<N>.php` -> `dembed.top/premiumtv/
 *            player.php?id=<N>`, whose page holds `const SRC = "https://
 *            edge.<host>/premium<N>/index.m3u8"`. The DaddyLive backend of
 *            dlhd.mts: every segment is a PNG with the TS hidden in its
 *            pixels, so these streams carry the `tiktikpx` decoder (copied
 *            from dlhd.mts; needs live-tv 1.6.0; older hosts drop them
 *            rather than offer them).
 *   trendy   `trendy48.online/live-tv?ch=<slug>` (mirror: `trend48.st`) ->
 *            iframe `trendy48.site/embed/<slug>` -> script-built iframe
 *            `exmxbxe.cfd/trefoxy/<slug>` (redirects to a signed path),
 *            whose JW Player setup is hidden in an XOR-and-shift number
 *            array (`(v ^ key) - offset`, the key and offset sit beside the
 *            array in the page; decoded here, no eval). It yields a signed
 *            `...junksonus.party/main/secure/<sig>/<expiry>/<slug>.m3u8`
 *            that plays with no headers, valid ~2.5h. The same PNG-wrapped
 *            segments as dlhd (`tiktokcdn` `.image` URLs), same decoder.
 *   streame  `streame.center/embed/ch<N>.php` -> iframe `hls2.php?stream=
 *            <id>` (needs a Referer, 403 without) -> `const streamUrl =
 *            "https://edgestream<k>.pro/hls/<id>.m3u8?st=<sig>&e=<expiry>"`
 *            (a few hours). The playlist needs `Referer: https://
 *            streame.center/`. Its feed for Willow answered 404 even in a
 *            real browser on 2026-10-03, so the segment format is UNVERIFIED
 *            -- it is offered as plain HLS, without the decoder.
 *
 *   NOT supported, and why (recorded so nobody retries them blindly):
 *   - `s1.vertex.st/ch?id=N` -> `api/player.php?id=N` -> `lineagest.click/
 *     e/<id>`: the stream config is an encrypted blob decoded by an
 *     obfuscated, devtools-hostile bundle, and the player never requested a
 *     stream in headless Chromium (25s, ads blocked or not).
 *   - `embed.st/embed/admin/...`: the Streamed/PPV `lock.wasm` family
 *     (73 imports, TLS-fingerprinted CDN); see SOURCES.md's Streamed row.
 *   Rows pointing at either are skipped. Any other host is skipped too.
 *
 * HANDLES AND THE RESOLVER
 *   Every address above is signed, expires within hours, or needs a
 *   multi-page handshake, so nothing is resolved in `build()`. A stream's
 *   `url` is a HANDLE (`https://crichd.invalid/<kind>/<key>`) and the host
 *   calls `resolvers.crichd` whenever it checks or plays it; see
 *   `ScrapedStream.resolver`. The resolver also fetches the playlist it
 *   found and answers `null` unless it is a real `#EXTM3U` -- a signed
 *   address is issued whether or not the channel is on air.
 *
 * NAMING, SO THE CHANNELS MERGE WITH iptv-org's
 *   Besides the event cards, every supported source is ALSO emitted as a
 *   plain channel ("TNT Sports 2", UK), so the host's name+country merge can
 *   add it as a mirror of the channel iptv-org (or any other source) already
 *   has. For that the name must be written the way the OTHER source writes
 *   it: quality words stripped ("Willow Cricket HD" -> "Willow Cricket"),
 *   then looked up in iptv-org's `channels.json` (names AND alt names, sports
 *   channels only) to adopt its spelling and country ("Sony Ten 1" ->
 *   "Sony Sports Ten 1", IN; "Willow Cricket" -> "Willow", US). A country the
 *   embed's own slug states (`tntsports2-uk`) disambiguates a name iptv-org
 *   has in several countries. No match is not an error: the cleaned name
 *   and whatever country is known are used as they are. The lookup file is
 *   ~8MB, fetched at most once a day, and its failure only costs the
 *   spelling.
 *
 *   The site's labels are not always right: on "Asian Games T20" a row named
 *   "Willow Cricket HD" links to `ch=sonysportsnetwork-in`. A trendy row
 *   whose slug disagrees with its label (first four letters) stays on the
 *   event card, as the site lists it, but is NOT emitted as a channel.
 */

import { gunzipSync, inflateSync } from "node:zlib";

// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see template/scraper-template.mts.
// -------------------------------------------------------------------------

interface ScrapedStream {
    url: string;
    quality: string;
    labels: string[];
    referrer: string;
    userAgent: string;
    decoder?: string;
    resolver?: string;
}

interface ResolvedStream {
    url: string;
    referrer?: string;
    userAgent?: string;
}

type StreamResolver = (handle: string) => Promise<ResolvedStream | null>;

type SegmentDecoder = (segment: Uint8Array, url: string) => Uint8Array | Promise<Uint8Array>;

/** Who is in a live event and when, so the host can merge it with the same fixture from other sources. */
interface ScrapedEvent {
    sides?: string[];
    title?: string;
    competition?: string;
    sport?: string;
    /** Epoch milliseconds; omitted when unknown. */
    start?: number;
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
    /** A fixture's two flags, drawn side by side by the host (`ScrapedChannel.logos`). */
    logos?: string[];
    event?: ScrapedEvent;
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
    decoders?: Record<string, SegmentDecoder>;
    resolvers?: Record<string, StreamResolver>;
    build(): Promise<ScrapedCatalogue>;
}

const SCRAPER_ID = "crichd";
const SITE = "https://crichd.at";
const SCRAPER_NAME = "CricHD";
const DECODER = "tiktikpx";
const RESOLVER = "crichd";
const HANDLE_HOST = "crichd.invalid";

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: fetch() resolves on
    // headers and the body read that follows is still tied to this signal.
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();

    try {
        return await work(controller.signal);
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}

async function getText(url: string, referrer = "", ms = 20_000): Promise<{ text: string; url: string }> {
    const response = await withTimeout(
        (signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(referrer ? { Referer: referrer } : {}) } }),
        ms
    );
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return { text: await response.text(), url: response.url };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const at = next++;
            results[at] = await work(items[at]!);
        }
    });
    await Promise.all(workers);
    return results;
}

function decodeEntities(text: string): string {
    return text
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}

// --- the listing ---------------------------------------------------------------

interface ListedEvent {
    slug: string;
    league: string;
    leagueLogo: string;
    start: number;
    end: number;
}

/** From ten minutes before the start (the links are up by then) to the end. */
const LEAD_MS = 10 * 60 * 1000;

async function fetchListing(now: number): Promise<ListedEvent[]> {
    const { text } = await getText(`${SITE}/`);
    // A 200 that is not this page at all (a parked domain, a changed
    // layout) must throw, not read as "nothing is on".
    if (!text.includes('id="content"') || !text.includes("countdown-status")) throw new Error("crichd: home page not recognised");

    const tokens = text.matchAll(
        /<img src="([^"]+)" alt="[^"]*"\s+width="28"[^>]*>\s*<div class="text-white font-semibold text-sm">([^<]+)<\/div>|href="\/events\/([^"?#]+)"|data-start="([^"]+)"\s+data-end="([^"]+)"/g
    );
    const events: ListedEvent[] = [];
    let league = "";
    let leagueLogo = "";
    let slug = "";

    for (const token of tokens) {
        if (token[2] !== undefined) {
            leagueLogo = token[1] || "";
            league = decodeEntities(token[2]);
        } else if (token[3] !== undefined) {
            slug = token[3];
        } else if (token[4] !== undefined && token[5] !== undefined && slug) {
            const start = Date.parse(token[4]);
            const end = Date.parse(token[5]);
            if (!Number.isNaN(start) && !Number.isNaN(end) && now >= start - LEAD_MS && now <= end && !events.some((e) => e.slug === slug)) {
                events.push({ slug, league, leagueLogo, start, end });
            }
            slug = "";
        }
    }

    return events;
}

// --- one event page ------------------------------------------------------------

interface SourceRow {
    /** "Link 1" */
    link: string;
    /** "Willow Cricket HD", as the site writes it. */
    channel: string;
    /** The "Quality" column. */
    quality: string;
    language: string;
    /** What "Watch" points at, with the site's own wrapper taken off. */
    embed: string;
}

async function fetchEventPage(slug: string): Promise<{ title: string; rows: SourceRow[]; flags: string[]; names: string[] }> {
    const { text } = await getText(`${SITE}/events/${encodeURIComponent(slug)}`);
    const title = decodeEntities(/<title>([^<]*)<\/title>/.exec(text)?.[1] || "")
        .replace(/\s*[-|]\s*CricHD\.at\s*$/i, "")
        .replace(/\s+Live\s+Stream(?:ing)?(?:\s+Online)?\s*$/i, "")
        .trim();
    const rows: SourceRow[] = [];

    /*
        THE TWO SIDES' PICTURES: the page draws team 1, the status, team 2,
        each as an `<img ... alt="<name> Logo">` over the name. A tournament
        page ("Asian Games T20") has the tournament as team 1 and the
        placeholder "Live" as team 2 -- not two flags, so no pair.
    */
    const sides = [...text.matchAll(/<img src="([^"]+)" alt="[^"]*" class="rounded shadow-lg[^"]*"\s*\/>\s*<div class="text-white text-sm font-semibold[^"]*">([^<]*)<\/div>/g)].map((m) => ({
        logo: decodeEntities(m[1]!),
        name: decodeEntities(m[2]!)
    }));
    const flags = sides.length === 2 && sides.every((side) => side.logo && !/^live$/i.test(side.name)) ? sides.map((side) => side.logo) : [];

    for (const tr of text.matchAll(/<tr class="hover[\s\S]*?<\/tr>/g)) {
        const cells = [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decodeEntities(m[1]!.replace(/<[^>]*>/g, "")));
        const href = /href="([^"]+)"/.exec(tr[0])?.[1];
        if (!href || cells.length < 6) continue;

        // `fr.php?src=<embed>`: the embed's own `?query` is not encoded, so
        // everything after `src=` is the embed.
        const wrapped = decodeEntities(href);
        const at = wrapped.indexOf("src=");
        const embed = at >= 0 ? wrapped.slice(at + 4) : wrapped;
        if (!/^https?:\/\//.test(embed)) continue;

        rows.push({ link: cells[0]!, channel: cells[1]!, quality: cells[3]!, language: cells[5]!, embed });
    }

    return { title, rows, flags, names: flags.length === 2 ? sides.map((side) => side.name.trim()) : [] };
}

// --- which embeds, and the handles for them --------------------------------------

type Kind = "dlhd" | "trendy" | "streame";

interface Source {
    kind: Kind;
    /** dlhd: the channel number. trendy: the slug. streame: "ch100". */
    key: string;
}

function classify(embed: string): Source | null {
    let url: URL;
    try {
        url = new URL(embed);
    } catch {
        return null;
    }

    const dlhd = /\/stream-(\d+)\.php$/.exec(url.pathname) || (/\/premiumtv\/\w+\.php$/.test(url.pathname) ? /^(\d+)$/.exec(url.searchParams.get("id") || "") : null);
    if (dlhd?.[1]) return { kind: "dlhd", key: dlhd[1] };

    const slug = url.pathname === "/live-tv" ? url.searchParams.get("ch") : null;
    if (slug && /^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { kind: "trendy", key: slug };

    const streame = url.hostname.endsWith("streame.center") ? /^\/embed\/(ch\d+)\.php$/.exec(url.pathname) : null;
    if (streame?.[1]) return { kind: "streame", key: streame[1] };

    return null;
}

function handleFor(source: Source): string {
    return `https://${HANDLE_HOST}/${source.kind}/${encodeURIComponent(source.key)}`;
}

function sourceOfHandle(handle: string): Source | null {
    try {
        const url = new URL(handle);
        const match = url.hostname === HANDLE_HOST ? /^\/(dlhd|trendy|streame)\/([^/]+)$/.exec(url.pathname) : null;
        return match ? { kind: match[1] as Kind, key: decodeURIComponent(match[2]!) } : null;
    } catch {
        return null;
    }
}

/** The pages to start from, best first; a mirror gone dark costs one request. */
function startPages(source: Source): { url: string; referrer: string }[] {
    const key = encodeURIComponent(source.key);

    if (source.kind === "dlhd") {
        return [
            { url: `https://dembed.top/premiumtv/player.php?id=${key}`, referrer: "https://daddylive1.cx/" },
            { url: `https://daddyliveplayer.st/premiumtv/daddy.php?id=${key}`, referrer: "https://dlhd.st/" }
        ];
    }
    if (source.kind === "trendy") {
        return [
            { url: `https://trendy48.online/live-tv?ch=${key}`, referrer: `${SITE}/` },
            { url: `https://trend48.st/live-tv?ch=${key}`, referrer: `${SITE}/` }
        ];
    }
    return [{ url: `https://streame.center/embed/${key}.php`, referrer: "https://hitsportshdd.xyz/" }];
}

/** What the playlist and its segments need on every request. Only streame
 *  checks; dlhd's and trendy's CDNs answer with no Referer at all. */
function referrerFor(kind: Kind): string {
    return kind === "streame" ? "https://streame.center/" : "";
}

// --- following an embed to its playlist ------------------------------------------

const AD_FRAME = /histats|google|amung|jsdelivr|cloudflare|jquery|doubleclick|\/ad\.html|aclib|plausible/i;
const NOT_A_PAGE = /\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|json|mp4)(?:[?#]|$)/i;

/** `&` and `\/` as a JS string literal in HTML spells them. */
function unescapeJs(text: string): string {
    return text.replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&");
}

/**
 * trendy's player is a number array decoded and eval'd by the page itself:
 * `var a=[..],b=<xor>,c=<offset>,...; ... (a[i] ^ b) - c + 256) % 256`.
 * The same arithmetic here, to text -- never executed.
 */
function decodePacked(html: string): string {
    let out = "";

    for (const match of html.matchAll(/var\s+\w+=\[([\d,\s]{40,})\],\s*\w+=(\d+),\s*\w+=(\d+),/g)) {
        const xor = Number(match[2]);
        const shift = Number(match[3]);
        const chars = match[1]!.split(",").map((n) => String.fromCharCode((((Number(n) ^ xor) - shift) % 256 + 256) % 256));
        out += `\n${chars.join("")}`;
    }

    return out;
}

function findPlaylist(html: string): string | null {
    const text = unescapeJs(html + decodePacked(html));
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g)) {
        if (!/example\.|\.invalid\//.test(match[0])) return match[0];
    }
    return null;
}

function findFrame(html: string, base: string): string | null {
    const text = unescapeJs(html + decodePacked(html));
    const candidates = [
        ...text.matchAll(/<iframe[^>]*?\ssrc=["']([^"']+)["']/gi),
        ...text.matchAll(/\.src\s*=\s*["']([^"']+)["']/g)
    ].map((m) => m[1]!);

    for (const raw of candidates) {
        try {
            const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, base);
            if (url.protocol === "https:" && !AD_FRAME.test(url.href) && !NOT_A_PAGE.test(url.pathname)) return url.href;
        } catch {
            // not a URL
        }
    }

    return null;
}

async function scan(url: string, referrer: string, deadline: number, depth = 0): Promise<string | null> {
    const left = deadline - Date.now();
    if (left < 500) return null;

    const page = await getText(url, referrer, Math.min(6_000, left));
    const playlist = findPlaylist(page.text);
    if (playlist) return playlist;

    const frame = depth < 4 ? findFrame(page.text, page.url) : null;
    return frame ? scan(frame, page.url, deadline, depth + 1) : null;
}

/** dlhd's edge host is the same for every channel and changes rarely, so
 *  the 650KB player page is read once per ten minutes, not per channel. */
let edgeCache: { base: string; at: number } | null = null;
const EDGE_TTL_MS = 10 * 60 * 1000;

async function playlistFor(source: Source, deadline: number): Promise<string | null> {
    if (source.kind === "dlhd" && edgeCache && Date.now() - edgeCache.at < EDGE_TTL_MS) {
        return `${edgeCache.base}/premium${source.key}/index.m3u8`;
    }

    for (const start of startPages(source)) {
        const found = await scan(start.url, start.referrer, deadline).catch(() => null);
        if (!found) continue;

        const edge = source.kind === "dlhd" ? /^(https:\/\/[^/]+)\/premium\d+\/index\.m3u8/.exec(found)?.[1] : undefined;
        if (edge) edgeCache = { base: edge, at: Date.now() };

        return found;
    }

    return null;
}

/** What the host asks for when a channel is checked or played. About twelve
 *  seconds are available, so the whole chain shares ten. */
async function resolveHandle(handle: string): Promise<ResolvedStream | null> {
    const source = sourceOfHandle(handle);
    if (!source) return null;

    const deadline = Date.now() + 10_000;
    const url = await playlistFor(source, deadline);
    if (!url) return null;

    // A signed address is issued whether or not the channel is on air.
    const referrer = referrerFor(source.kind);
    const alive = await getText(url, referrer, Math.max(1_000, deadline - Date.now()))
        .then((playlist) => playlist.text.trimStart().startsWith("#EXTM3U"))
        .catch(() => false);
    if (!alive) {
        if (source.kind === "dlhd") edgeCache = null;
        return null;
    }

    return { url, referrer: referrer || undefined, userAgent: BROWSER_UA };
}

// --- names, countries, languages -------------------------------------------------

function fold(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

/** "Willow Cricket HD" -> "Willow Cricket". */
function cleanChannelName(raw: string): string {
    return raw
        .replace(/[([][^)\]]*[)\]]/g, " ")
        .replace(/\b(?:4k|uhd|fhd|hd|sd|hq|(?:360|480|576|720|1080|1440|2160)p?)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** The resolution the channel's name states, or "". */
function resolutionOf(raw: string): string {
    const explicit = /\b(4k|uhd|fhd|(?:360|480|576|720|1080|1440|2160)p?)\b/i.exec(raw)?.[1]?.toLowerCase();
    if (explicit) return /^\d+$/.test(explicit) ? `${explicit}p` : explicit === "fhd" ? "1080p" : explicit.toUpperCase().replace("UHD", "4K");
    if (/\bhd\b/i.test(raw)) return "HD";
    if (/\bsd\b/i.test(raw)) return "SD";
    return "";
}

function qualityOf(row: SourceRow): string {
    const named = resolutionOf(row.channel);
    if (named) return named;

    // The column: constant 1500 on every row seen, so a bitrate, not a size.
    const number = Number(row.quality);
    return Number.isFinite(number) && number > 0 ? `${number} kbps` : "";
}

/** English name -> ISO 639-3, for the languages the site lists. */
const LANGUAGES: Record<string, string> = {
    english: "eng", hindi: "hin", urdu: "urd", bengali: "ben", bangla: "ben", tamil: "tam", telugu: "tel", kannada: "kan",
    malayalam: "mal", marathi: "mar", gujarati: "guj", punjabi: "pan", nepali: "nep", sinhala: "sin", sinhalese: "sin",
    arabic: "ara", persian: "fas", farsi: "fas", pashto: "pus", dari: "prs", spanish: "spa", portuguese: "por", french: "fra",
    german: "deu", italian: "ita", russian: "rus", turkish: "tur", afrikaans: "afr", swahili: "swa", dutch: "nld", pidgin: "pcm"
};

function languageCode(name: string): string {
    return LANGUAGES[name.trim().toLowerCase()] || "";
}

/** A country as an embed's slug states it (`willow-usa`, `tntsports2-uk`), in iptv-org's codes. */
const SLUG_COUNTRIES: Record<string, string> = {
    usa: "US", us: "US", uk: "UK", gb: "UK", in: "IN", ind: "IN", pk: "PK", pak: "PK", au: "AU", aus: "AU", ca: "CA",
    nz: "NZ", za: "ZA", bd: "BD", lk: "LK", ae: "AE", sa: "SA", ie: "IE", np: "NP", af: "AF", ng: "NG", ke: "KE"
};

function slugParts(slug: string): { base: string; country: string } {
    const match = /^(.*?)-([a-z]{2,3})$/i.exec(slug);
    const country = match ? SLUG_COUNTRIES[match[2]!.toLowerCase()] || "" : "";
    return { base: country && match ? match[1]! : slug, country };
}

/** Does an embed's slug plausibly name the channel its row claims? */
function slugAgrees(label: string, slugBase: string): boolean {
    const a = fold(cleanChannelName(label)).slice(0, 4);
    const b = fold(slugBase).slice(0, 4);
    return a.length > 0 && a === b;
}

function flagOf(code: string): string {
    const iso = code === "UK" ? "GB" : code;
    if (!/^[A-Z]{2}$/.test(iso)) return "";
    return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function countryNameOf(code: string): string {
    try {
        return new Intl.DisplayNames(["en"], { type: "region" }).of(code === "UK" ? "GB" : code) || code;
    } catch {
        return code;
    }
}

/** A name this site spells differently from the rest of the world, where
 *  iptv-org's own alt names do not already say so. */
const ALIASES: Record<string, string> = {
    willowcricket: "Willow"
};

interface KnownChannel {
    name: string;
    country: string;
    /** Matched by its own name, not an alternative. */
    primary: boolean;
}

let knownCache: { at: number; byName: Map<string, KnownChannel[]> } | null = null;
let knownInFlight: Promise<Map<string, KnownChannel[]>> | null = null;
const KNOWN_TTL_MS = 24 * 60 * 60 * 1000;

/** iptv-org's sports channels by every name they go by. Never throws: the
 *  worst a failure costs is a spelling. */
function knownChannels(): Promise<Map<string, KnownChannel[]>> {
    if (knownCache && Date.now() - knownCache.at < KNOWN_TTL_MS) return Promise.resolve(knownCache.byName);

    knownInFlight ||= (async () => {
        try {
            const response = await withTimeout((signal) => fetch("https://iptv-org.github.io/api/channels.json", { signal }), 60_000);
            if (!response.ok) throw new Error(`channels.json -> ${response.status}`);

            const raw = (await response.json()) as { name?: string; alt_names?: string[]; country?: string; categories?: string[]; closed?: string | null }[];
            const byName = new Map<string, KnownChannel[]>();
            const add = (key: string, entry: KnownChannel): void => {
                if (!key) return;
                const list = byName.get(key) || [];
                if (!list.some((e) => e.name === entry.name && e.country === entry.country)) list.push(entry);
                byName.set(key, list);
            };

            for (const channel of raw) {
                if (!channel.name || !channel.country || channel.closed || !channel.categories?.includes("sports")) continue;

                add(fold(channel.name), { name: channel.name, country: channel.country, primary: true });
                for (const alt of channel.alt_names || []) add(fold(alt), { name: channel.name, country: channel.country, primary: false });
            }

            knownCache = { at: Date.now(), byName };
        } catch (cause) {
            console.error("crichd: iptv-org names unavailable, using the site's own", cause);
            knownCache ||= { at: Date.now() - KNOWN_TTL_MS + 10 * 60 * 1000, byName: new Map() };
        } finally {
            knownInFlight = null;
        }

        return knownCache!.byName;
    })();

    return knownInFlight;
}

/** The name and country the rest of the index would know this channel by. */
function canonical(cleaned: string, hint: string, known: Map<string, KnownChannel[]>): { name: string; country: string } {
    const alias = ALIASES[fold(cleaned)];
    const candidates = known.get(fold(alias || cleaned)) || [];
    const sameCountry = hint ? candidates.filter((c) => c.country === hint) : [];
    const pool = sameCountry.length ? sameCountry : candidates;
    const countries = new Set(pool.map((c) => c.country));

    // Several countries and nothing to choose by: guessing would put the
    // stream on another country's channel.
    if (pool.length && countries.size === 1) {
        const best = pool.find((c) => c.primary) || pool[0]!;
        return { name: best.name, country: best.country };
    }

    return { name: alias || cleaned, country: hint };
}


// --- the decoder (copied from dlhd.mts: the same disguise) --------------------

const TPIX = [84, 73, 75, 84, 73, 75, 80, 88]; // "TIKTIKPX"
const TRAW = [84, 73, 75, 84, 73, 75, 82, 65, 87]; // "TIKTIKRAW"
const TSGZ = [84, 73, 75, 84, 73, 75, 84, 83, 71, 90]; // "TIKTIKTSGZ"

function isTs(bytes: Uint8Array, at = 0): boolean {
    return bytes[at] === 0x47 && (at + 188 >= bytes.length || bytes[at + 188] === 0x47);
}

function find(bytes: Uint8Array, tag: number[]): number {
    outer: for (let i = 0; i + tag.length < bytes.length; i++) {
        for (let j = 0; j < tag.length; j++) if (bytes[i + j] !== tag[j]) continue outer;
        return i;
    }
    return -1;
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/** PNG -> its pixels as packed RGB, or null for any PNG this cannot be
 *  (not 8-bit, interlaced, not RGB/RGBA). */
function pngRgb(bytes: Uint8Array): Uint8Array | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let interlace = 0;
    const idat: Uint8Array[] = [];

    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12) return null;
        const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
        const data = bytes.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") {
            width = view.getUint32(off + 8);
            height = view.getUint32(off + 12);
            depth = data[8]!;
            colour = data[9]!;
            interlace = data[12]!;
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        off += 12 + len;
    }

    if (!width || !height || depth !== 8 || interlace || (colour !== 2 && colour !== 6)) return null;

    const raw = inflateSync(Buffer.concat(idat));
    const bpp = colour === 6 ? 4 : 3;
    const stride = width * bpp;
    const rgb = new Uint8Array(width * height * 3);
    let src = 0;
    let dst = 0;
    let prev = new Uint8Array(stride);

    for (let y = 0; y < height; y++) {
        if (src + 1 + stride > raw.length) return null;
        const filter = raw[src++]!;
        const row = raw.subarray(src, src + stride);
        src += stride;
        const out = new Uint8Array(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[i - bpp]! : 0;
            const b = prev[i]!;
            const c = i >= bpp ? prev[i - bpp]! : 0;
            let v = row[i]!;
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) v += paeth(a, b, c);
            else if (filter !== 0) return null;
            out[i] = v & 255;
        }
        if (colour === 2) {
            rgb.set(out, dst);
            dst += stride;
        } else {
            for (let i = 0; i < stride; i += 4) {
                rgb[dst++] = out[i]!;
                rgb[dst++] = out[i + 1]!;
                rgb[dst++] = out[i + 2]!;
            }
        }
        prev = out;
    }

    return rgb;
}

/** The newest layout: TS gzipped into the pixels, behind "TIKTIKPX". */
function fromPixels(bytes: Uint8Array): Uint8Array | null {
    const rgb = pngRgb(bytes);
    if (!rgb || rgb.length < 12) return null;
    for (let k = 0; k < TPIX.length; k++) if (rgb[k] !== TPIX[k]) return null;
    const size = new DataView(rgb.buffer, rgb.byteOffset + 8, 4).getUint32(0);
    if (size <= 0 || 12 + size > rgb.length) return null;
    const ts = gunzipSync(rgb.subarray(12, 12 + size));
    return isTs(ts) ? new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength) : null;
}

/** An older layout: TS appended after the PNG's IEND chunk. */
function afterIend(bytes: Uint8Array): Uint8Array | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12) return null;
        const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
        off += 12 + len;
        if (type === "IEND") return off < bytes.length && isTs(bytes, off) ? bytes.subarray(off) : null;
    }
    return null;
}

/** An older layout still: TS in a WebP's EXIF chunk. */
function webpExif(bytes: Uint8Array): Uint8Array | null {
    const ascii = (at: number, n: number): string => String.fromCharCode(...bytes.subarray(at, at + n));
    if (bytes.length < 16 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 12;
    while (off + 8 <= bytes.length) {
        const tag = ascii(off, 4);
        const n = view.getUint32(off + 4, true);
        off += 8;
        if (off + n > bytes.length) return null;
        if (tag === "EXIF") {
            const data = bytes.subarray(off, off + n);
            return data.length > 188 && isTs(data) ? data : null;
        }
        off += n + (n & 1);
    }
    return null;
}

/** Exported for the standalone check below; the host calls it through
 *  `decoders.tiktikpx`. */
export function unwrapSegment(bytes: Uint8Array): Uint8Array {
    if (isTs(bytes)) return bytes;

    const webp = webpExif(bytes);
    if (webp) return webp;

    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
        const tail = afterIend(bytes);
        if (tail) return tail;
        const pixels = fromPixels(bytes);
        if (pixels) return pixels;
        throw new Error("crichd: PNG segment with no TS payload");
    }

    const raw = find(bytes, TRAW);
    if (raw >= 0 && isTs(bytes, raw + TRAW.length)) return bytes.subarray(raw + TRAW.length);

    const gz = find(bytes, TSGZ);
    if (gz >= 0) {
        const ts = gunzipSync(bytes.subarray(gz + TSGZ.length));
        return new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength);
    }

    for (let i = 0; i + 188 < bytes.length; i++) if (isTs(bytes, i)) return bytes.subarray(i);

    throw new Error("crichd: segment with no TS payload");
}


// --- events -> cards and channels ------------------------------------------------

interface Fetched {
    events: ScrapedChannel[];
    channels: ScrapedChannel[];
}

function streamFor(source: Source, row: SourceRow): ScrapedStream {
    const mislabelled = source.kind === "trendy" && !slugAgrees(row.channel, slugParts(source.key).base);

    return {
        url: handleFor(source),
        quality: qualityOf(row),
        labels: [row.channel, row.language, ...(mislabelled ? ["Name unverified"] : [])].filter(Boolean),
        referrer: "",
        userAgent: "",
        resolver: RESOLVER,
        // streame's segment format is unverified (its feed was down); the
        // other two are PNG-wrapped.
        ...(source.kind === "streame" ? {} : { decoder: DECODER })
    };
}

async function fetchLive(): Promise<Fetched> {
    const listed = await fetchListing(Date.now());
    if (!listed.length) return { events: [], channels: [] };

    const pages = await mapWithConcurrency(listed, 4, async (event) => ({
        event,
        page: await fetchEventPage(event.slug).catch((cause) => {
            console.error(`crichd: ${event.slug} skipped`, cause);
            return null;
        })
    }));
    // Every page failing is the site being down, not nothing being on.
    if (pages.every((p) => !p.page)) throw new Error("crichd: no event page could be read");

    const known = await knownChannels();
    const events: ScrapedChannel[] = [];
    const channels = new Map<string, ScrapedChannel>();

    for (const { event, page } of pages) {
        if (!page) continue;

        const rows = page.rows.flatMap((row) => {
            const source = classify(row.embed);
            return source ? [{ row, source }] : [];
        });
        if (!rows.length) {
            console.error(`crichd: ${event.slug}: none of ${page.rows.length} sources is a supported embed`);
            continue;
        }

        // A country the slug states for one row serves every row of that name.
        const hints = new Map<string, string>();
        for (const { row, source } of rows) {
            if (source.kind !== "trendy") continue;
            const { base, country } = slugParts(source.key);
            if (country && slugAgrees(row.channel, base)) hints.set(fold(cleanChannelName(row.channel)), country);
        }

        const streams: ScrapedStream[] = [];
        const languages = new Set<string>();

        for (const { row, source } of rows) {
            const stream = streamFor(source, row);
            const code = languageCode(row.language);

            if (code) languages.add(code);
            if (!streams.some((s) => s.url === stream.url)) streams.push(stream);

            if (stream.labels.includes("Name unverified")) continue;

            const cleaned = cleanChannelName(row.channel);
            if (!cleaned) continue;

            const own = source.kind === "trendy" ? slugParts(source.key).country : "";
            const { name, country } = canonical(cleaned, own || hints.get(fold(cleaned)) || "", known);
            const id = idFor(`channel:${fold(name)}:${country.toLowerCase() || "xx"}`);
            const channel = channels.get(id) || {
                id,
                name,
                country,
                countryName: country ? countryNameOf(country) : "",
                countryFlag: country ? flagOf(country) : "",
                categories: ["sports"],
                languages: [],
                logo: "",
                website: SITE,
                network: "",
                streams: []
            };

            if (!channel.streams.some((s) => s.url === stream.url)) channel.streams.push(stream);
            if (code && !channel.languages.includes(code)) channel.languages.push(code);
            channels.set(id, channel);
        }

        const league = event.league.toLowerCase();

        events.push({
            id: idFor(`event:${event.slug}`),
            name: page.title || event.slug.replace(/-/g, " "),
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", "cricket", ...(league && league !== "cricket" ? [league] : [])],
            languages: [...languages],
            // Both flags drawn together where the page has two sides; the league's own picture otherwise.
            logo: page.flags[0] || event.leagueLogo,
            ...(page.flags.length === 2 ? { logos: page.flags } : {}),
            // Who and when, so the host merges this with the same fixture from other sources.
            event: {
                ...(page.names.length === 2 ? { sides: page.names } : { title: page.title || event.slug.replace(/-/g, " ") }),
                ...(event.league ? { competition: event.league } : {}),
                sport: "cricket",
                ...(event.start > 0 ? { start: event.start } : {})
            },
            website: `${SITE}/events/${event.slug}`,
            network: SCRAPER_NAME,
            streams
        });
    }

    return { events, channels: [...channels.values()] };
}

// --- tasks, caches and build() -----------------------------------------------------

const configSchema: ScraperConfigField[] = [
    {
        key: "eventsIntervalMinutes",
        label: "Live matches refresh interval (minutes)",
        type: "number",
        default: 30,
        min: 10,
        help: "How often the home page is re-read for matches that are on now, and each match's channel list."
    }
];

/** Single-flight cache, same reasoning as dlhd.mts's. */
let cache: Fetched | null = null;
let inFlight: Promise<Fetched> | null = null;

function ensure(): Promise<Fetched> {
    if (cache) return Promise.resolve(cache);
    inFlight ||= fetchLive()
        .then((result) => (cache = result))
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

const tasks: ScraperTask[] = [
    {
        id: "events",
        label: "Refresh live matches",
        intervalConfigKey: "eventsIntervalMinutes",
        async run() {
            const previous = cache;
            cache = null;
            try {
                await ensure();
            } catch (cause) {
                cache = previous;
                throw cause;
            }
        }
    }
];

async function build(): Promise<ScrapedCatalogue> {
    const { events, channels } = await ensure();
    const ids = events.map((e) => e.id);

    return {
        channels: [...events, ...channels],
        /*
            TWO RAILS, ONE CONTENT. "Live Events" is the heading every
            live-events scraper here shares, so the host merges them into
            one rail with one card per fixture; "Live Cricket" is the one
            ntvst gives its cricket fixtures. Both are exact on purpose.
        */
        rails: ids.length
            ? [
                  { id: "live-events", heading: "Live Events", channelIds: ids, group: "Live events" },
                  { id: "live-cricket", heading: "Live Cricket", channelIds: ids, group: "Live events" }
              ]
            : []
    };
}

export const crichdScraper: Scraper = {
    id: SCRAPER_ID,
    name: SCRAPER_NAME,
    version: "1.2.0",
    configSchema,
    tasks,
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    resolvers: { [RESOLVER]: resolveHandle },
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/crichd.mts` -- prints what is live, then resolves every
// distinct source and checks its playlist and first segment decode, so a
// change in any embed shows up here, not on a sofa.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const catalogue = await build();
        const events = catalogue.channels.filter((c) => c.id.includes(":event:"));
        console.log(`${events.length} live events, ${catalogue.channels.length - events.length} channels, ${(catalogue.rails || []).length} rails`);

        for (const event of events) {
            console.log(`\n${event.name}  [${event.categories.join(", ")}]  languages=${event.languages.join(",") || "-"}`);
            for (const stream of event.streams) console.log(`  ${stream.url}  ${stream.quality}  ${stream.labels.join(" | ")}${stream.decoder ? "  (decoder)" : ""}`);
        }
        for (const channel of catalogue.channels.filter((c) => !c.id.includes(":event:"))) {
            console.log(`channel: ${channel.name} [${channel.country || "-"}] x${channel.streams.length}`);
        }

        const handles = new Map<string, ScrapedStream>();
        for (const channel of catalogue.channels) for (const stream of channel.streams) handles.set(stream.url, stream);

        for (const [handle, stream] of handles) {
            const resolved = await resolveHandle(handle);
            if (!resolved) {
                console.log(`\n${handle}: not resolvable / not on air right now`);
                continue;
            }

            const headers = { "User-Agent": BROWSER_UA, ...(resolved.referrer ? { Referer: resolved.referrer } : {}) };
            const playlist = await (await fetch(resolved.url, { headers })).text();
            const segmentUrl = playlist.split("\n").find((line) => /^https?:/.test(line.trim()));
            if (!segmentUrl) {
                console.log(`\n${handle} -> ${resolved.url}: playlist without segments`);
                continue;
            }

            const segment = new Uint8Array(await (await fetch(segmentUrl.trim(), { headers })).arrayBuffer());
            const ts = stream.decoder ? unwrapSegment(segment) : segment;
            console.log(`\n${handle} -> ${resolved.url}\n  segment: ${segment.length} bytes in, ${ts.length} out, TS sync ${ts[0] === 0x47 && ts[188] === 0x47}`);
        }
    })().catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
