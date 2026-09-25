/**
 * ntv.st -- 24/7 live-TV channels plus a live sporting-events rail.
 *
 * Ported from the `DirectScraper`-style plugin (`scrapers/ntvst.py` in this
 * same repo / in riven-tpdb-scrapers) to the `Scraper.build()` contract
 * described in `docs/scraper-template.ts`. The reverse-engineering notes
 * below are unchanged from that plugin -- only the shape of the output
 * (one `build()` call returning every channel up front, rather than a
 * `search`/`resolve` pair called on demand) is new.
 *
 * **The site multiplexes three completely different backends behind one
 * channel list**, named in its own JSON as `cdnlive`, `hesgoales` and
 * `dlhd` (~4% / ~87% / ~9% of ~10.4k channels, sampled 2026-09). Three of
 * the four resulting backends are handled here:
 *
 * - `cdnlive` channels carry their own `channel_url` straight in the list
 *   response, pointing at cdnlivetv.tv's player page. That page's HTML is
 *   regenerated per-request with randomised variable names wrapping a
 *   fixed shape: several `var <random>='<base64url fragment>';`
 *   assignments and one assembly line `var <random>=<decoder>(<fragA>)+
 *   <decoder>(<fragB>)+...;` whose *value* -- not its name -- is the live
 *   `.m3u8` URL. `extractCdnliveStreamUrl` reads the assembly line's shape
 *   to learn which fragments to decode and in what order, since the
 *   identifiers themselves change every fetch.
 * - `hesgoales` channels (the largest backend) fan out through two
 *   unrelated sites:
 *   - `hesgoal.team` is a dead end on its own -- it just iframes
 *     `wideiptv.top/player/<slug>` after cleaning the id
 *     (`id.trim().replace(/[/\.?&=]/g, '')`, replicated in
 *     `cleanHesgoalSlug`). That page hands back the stream URL in the
 *     clear, a plain `streamUrl: "https:\/\/<cdn>/<slug>/index.m3u8?
 *     token=..."` JS literal -- no obfuscation, unlike `cdnlive`.
 *   - `epicsports-tv.com` (~75% of this bucket -- the majority of the
 *     *entire* catalogue) polls its own `/decode.php` for a
 *     `{token, code}` pair used to build a chunked `video/webm` URL.
 *     `decode.php` takes no query string of its own -- the channel id it
 *     needs travels only in the `Referer` header
 *     (`https://epicsports-tv.com/eu.html?id=<id>`) -- and is genuinely
 *     flaky, succeeding roughly half the time even with correct params
 *     (the site's own page just retries on exactly this failure, so
 *     `decodeEpicsports` does too).
 * - `dlhd` channels resolve to an iframe on `dlhd.st`/`dlive.sx`, a
 *   distinct third-party streaming service with an actively anti-tamper-
 *   protected ~90KB obfuscated bundle and a domain lock on its second
 *   player hop (`assetrage.net`). Confirmed unsolved by running the
 *   extracted payload in a sandboxed Node `vm` (stubbed browser globals,
 *   no real network): patching `Function` to trace calls made the code
 *   detect the instrumentation and sabotage its own execution rather than
 *   proceed. Left unresolved here -- channels on this backend are skipped
 *   rather than guessed at.
 *
 * `buildEventsRail()` is a second, unrelated bulk-export for ntv.st's
 * *live events* (single sporting fixtures, e.g. "Liverpool FC v.
 * Manchester United"), sourced from `/api/get-matches`, not the channel
 * index. It targets the `falcon` mirror server, not `kobra` (the
 * homepage's own default): `kobra`'s events all dead-end at the same
 * unsolved `dlhd`-family backend above, while `falcon` resolves cleanly
 * through `livelive24.com` to bare, directly-playable `.m3u8` URLs, in
 * exchange for a different (mostly disjoint) event catalogue.
 *
 * Every resolved URL, from every backend, carries a short-lived token
 * (minutes, not hours). Nothing here should be cached -- `build()` fetches
 * everything fresh on every call, same as the nightly rebuild expects.
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
    /** See stremio-tv's scraper-types.ts -- lets a GitHub re-import know
     *  this is a genuine update rather than a blind re-copy. */
    version?: string;
    configSchema?: ScraperConfigField[];
    tasks?: ScraperTask[];
    build(): Promise<ScrapedCatalogue>;
}

const SCRAPER_ID = "ntvst";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await work(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

/** Runs `items` through `worker` with at most `limit` in flight at once --
 *  the channel/match catalogues are large enough (thousands of entries,
 *  each needing its own resolve round-trip) that running them fully in
 *  parallel would hammer ntv.st's upstreams; fully serial would be far too
 *  slow for a twelve-hourly rebuild. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function run() {
        while (next < items.length) {
            const i = next++;
            results[i] = await worker(items[i]!);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}

const BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

//: ntv.st's own API rate-limits fairly aggressively under a burst of
//: back-to-back requests -- CHANNEL_PAGE_PACING_MS below avoids tripping
//: it in the first place for the common case, but a channel resolve
//: (resolveHesgoal, resolveEpicsports) can still legitimately burst
//: against a THIRD-PARTY host, so this stays as a safety net. Retrying
//: with backoff clears it in practice; it is not a sign the request
//: itself was wrong.
const RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_BACKOFF_MS = 2_000;

async function fetchText(url: string, init?: { headers?: Record<string, string> }): Promise<string> {
    for (let attempt = 0; ; attempt++) {
        const response = await withTimeout((signal) =>
            fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(init?.headers || {}) } })
        );
        if (response.ok) return response.text();

        if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
            await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS * (attempt + 1)));
            continue;
        }
        throw new Error(`${url} -> ${response.status}`);
    }
}

async function fetchJson<T>(url: string, init?: { headers?: Record<string, string> }): Promise<T> {
    return JSON.parse(await fetchText(url, init)) as T;
}

// --- live events (buildEventsRail) ---------------------------------------

const MATCH_INDEX_URL = "https://ntv.st/api/get-matches";
//: `falcon`, not `kobra` (the homepage tab's own default) -- see the module
//: docstring for why.
const DEFAULT_MATCH_SERVER = "falcon";
const EMBED_TOKEN_RE = /embed\?t=[^"'&]+/;
const STREAM_IFRAME_SRC_RE = /id="streamIframe"[\s\S]{0,80}?src="([^"]+)"/;

/** The bare `.m3u8` URL behind a `livelive24.com` embed link, or `null` if
 *  `embedUrl` isn't one of the two known livelive24.com shapes. */
function extractLivelive24StreamUrl(embedUrl: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(embedUrl);
    } catch {
        return null;
    }
    if (parsed.hostname !== "livelive24.com") return null;

    const raw = parsed.searchParams.get("url");
    if (!raw) return null;

    if (parsed.pathname === "/dlhd.html") {
        const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
        try {
            return Buffer.from(padded, "base64").toString("utf-8");
        } catch {
            return null;
        }
    }

    if (parsed.pathname === "/test.html") {
        // `URLSearchParams.get` already undoes ordinary query-string
        // escaping in one step -- no second decode needed or correct here.
        return raw;
    }

    return null;
}

// --- cdnlive ---------------------------------------------------------------

const FRAGMENT_ASSIGN_RE = /var (\w+)='([^']*)';/g;
//: The assembly line the player HTML uses to build its live URL: some
//: variable set to a chain of `<decoderName>(<fragmentName>)` calls. The
//: decoder's own name is random too, so only the shape is matched here.
const ASSEMBLY_RE = /var \w+=((?:\w+\(\w+\)\+?)+);/;
const CALL_RE = /\w+\((\w+)\)/g;

/** Undo cdnlivetv.tv's base64url-ish encoding of one URL fragment. */
function b64urlDecode(fragment: string): string {
    const padded = fragment.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    try {
        return Buffer.from(withPad, "base64").toString("utf-8");
    } catch {
        return "";
    }
}

/** The live `.m3u8` URL hidden in a cdnlivetv.tv player page -- reads the
 *  shape of the assembly line rather than any fixed variable name, since
 *  every name in the page is randomised per request. */
function extractCdnliveStreamUrl(page: string): string | null {
    const assembly = ASSEMBLY_RE.exec(page);
    if (!assembly) return null;

    const fragmentNames: string[] = [];
    for (const m of assembly[1]!.matchAll(CALL_RE)) fragmentNames.push(m[1]!);
    if (fragmentNames.length === 0) return null;

    const fragments = new Map<string, string>();
    for (const m of page.matchAll(FRAGMENT_ASSIGN_RE)) fragments.set(m[1]!, m[2]!);

    const parts: string[] = [];
    for (const name of fragmentNames) {
        const fragment = fragments.get(name);
        if (fragment === undefined) return null;
        parts.push(b64urlDecode(fragment));
    }
    if (parts.some((p) => !p)) return null;

    const url = parts.join("");
    return url.startsWith("http") ? url : null;
}

// --- hesgoales / hesgoal.team -----------------------------------------------

//: Both hesgoal.team and epicsports-tv.com carry their channel's id as
//: `?id=<...>` on the `channel_url` ntv.st's index hands back.
const ID_PARAM_RE = /[?&]id=([^&]+)/;
//: The exact character class hesgoal.team's own inline JS strips from the
//: `id` query parameter before handing it to wideiptv.top.
const HESGOAL_UNSAFE_SLUG_CHARS_RE = /[/\\.?&=]/g;
const HESGOAL_STREAM_URL_RE = /streamUrl["']?\s*:\s*"([^"]+)"/;

function cleanHesgoalSlug(rawId: string): string {
    return rawId.trim().replace(HESGOAL_UNSAFE_SLUG_CHARS_RE, "") || "SPT1";
}

/** The live `.m3u8` URL out of a wideiptv.top player page -- a plain JS
 *  string literal, the only work is undoing its `\/` escape. */
function extractHesgoalStreamUrl(page: string): string | null {
    const match = HESGOAL_STREAM_URL_RE.exec(page);
    if (!match) return null;
    const url = match[1]!.replace(/\\\//g, "/");
    return url.startsWith("http") ? url : null;
}

// --- hesgoales / epicsports-tv.com ------------------------------------------

const EPICSPORTS_DECODE_URL = "https://epicsports-tv.com/decode.php";
const EPICSPORTS_STREAM_BASE = "https://uv.dreamstream.cc";
//: `decode.php` genuinely fails to extract its own server-side number on
//: roughly half of all requests -- not avoidable, and not different from
//: what the site's own player does (it retries on exactly this error too).
const EPICSPORTS_DECODE_ATTEMPTS = 8;

interface EpicsportsPair {
    token: string;
    code: string;
}

/** The `{token, code}` pair `decode.php` hands out for one channel. Takes
 *  no query string of its own -- the channel id travels only in `Referer`. */
async function decodeEpicsports(channelId: string): Promise<EpicsportsPair | null> {
    for (let i = 0; i < EPICSPORTS_DECODE_ATTEMPTS; i++) {
        let data: any;
        try {
            data = await fetchJson<any>(EPICSPORTS_DECODE_URL, {
                headers: {
                    Accept: "application/json",
                    Referer: `https://epicsports-tv.com/eu.html?id=${channelId}`,
                },
            });
        } catch {
            continue;
        }
        const parsed = data?.parsed_data || {};
        if (parsed.status === "OK" && parsed.token && parsed.code) {
            return { token: parsed.token, code: parsed.code };
        }
    }
    return null;
}

// --- per-backend resolvers ---------------------------------------------------

async function resolveCdnlive(channelUrl: string): Promise<ScrapedStream | null> {
    const page = await fetchText(channelUrl);
    const streamUrl = extractCdnliveStreamUrl(page);
    if (!streamUrl) return null;

    return {
        url: streamUrl,
        quality: "",
        labels: [],
        // The token in `streamUrl` is short-lived and IP-bound in practice,
        // so it is fetched fresh on every `build()` call rather than cached.
        referrer: "https://cdnlivetv.tv/",
        userAgent: BROWSER_UA,
    };
}

async function resolveHesgoal(slug: string): Promise<ScrapedStream | null> {
    const page = await fetchText(`https://wideiptv.top/player/${slug}`, {
        headers: { Referer: "https://hesgoal.team/" },
    });
    const streamUrl = extractHesgoalStreamUrl(page);
    if (!streamUrl) return null;

    return {
        url: streamUrl,
        quality: "",
        labels: [],
        referrer: "https://wideiptv.top/",
        userAgent: BROWSER_UA,
    };
}

async function resolveEpicsports(channelId: string): Promise<ScrapedStream | null> {
    const pair = await decodeEpicsports(channelId);
    if (!pair) return null;

    // Whether this URL is actually live is not checked here -- a dead
    // channel surfaces as a 404 from uv.dreamstream.cc at play time, which
    // the nightly playability sweep catches, not something build() decides.
    const streamUrl = `${EPICSPORTS_STREAM_BASE}/${pair.token}/${pair.code}/${channelId}/webm`;

    return {
        url: streamUrl,
        quality: "",
        labels: [],
        referrer: "https://epicsports-tv.com/",
        userAgent: BROWSER_UA,
    };
}

interface NtvChannel {
    channel_name?: string;
    channel_image?: string;
    channel_url?: string;
    server?: string;
}

/** Resolves one raw channel entry from `/api/get-channels` to its stream,
 *  routing to whichever backend actually serves it. Returns `null` for
 *  `dlhd` channels (unresolved -- see the module docstring) and for any
 *  channel whose resolve step fails, rather than throwing -- one dead
 *  channel should not take down the whole catalogue build. */
async function resolveChannelStream(channel: NtvChannel): Promise<ScrapedStream | null> {
    const server = channel.server || "";
    const channelUrl = channel.channel_url || "";

    try {
        if (server === "cdnlive") {
            return channelUrl ? await resolveCdnlive(channelUrl) : null;
        }

        if (server === "hesgoales") {
            let host = "";
            try {
                host = new URL(channelUrl).hostname;
            } catch {
                return null;
            }

            if (host === "hesgoal.team") {
                const match = ID_PARAM_RE.exec(channelUrl);
                if (!match) return null;
                return await resolveHesgoal(cleanHesgoalSlug(decodeURIComponent(match[1]!)));
            }

            if (host === "epicsports-tv.com") {
                const match = ID_PARAM_RE.exec(channelUrl);
                if (!match) return null;
                return await resolveEpicsports(decodeURIComponent(match[1]!).trim());
            }

            // The small remainder of `hesgoales` on other hosts (e.g.
            // hesgoaler.com) is left unresolved rather than guessed at.
            return null;
        }

        // `dlhd` -- unresolved, see the module docstring.
        return null;
    } catch {
        return null;
    }
}

interface GetChannelsResponse {
    success?: boolean;
    channels?: NtvChannel[];
    has_more?: boolean;
}

const CHANNEL_INDEX_URL = "https://ntv.st/api/get-channels";
//: The API caps `limit` at 100 server-side regardless of what is
//: requested, so paging by 100 is the fastest this endpoint allows.
const CHANNEL_PAGE_SIZE = 100;
//: Bounds how many channel resolves (each its own HTTP round-trip against
//: cdnlivetv.tv/wideiptv.top/epicsports-tv.com) run at once.
const CHANNEL_RESOLVE_CONCURRENCY = 12;

//: Measured against the real API: firing pagination requests back-to-back
//: with no pacing trips its rate limiter after roughly 35-60 consecutive
//: requests (varies by run), and once tripped it can take longer to clear
//: than RATE_LIMIT_RETRIES' backoff allows, failing the whole build. A
//: flat 250ms between page requests -- confirmed empirically to clear the
//: entire ~12k-channel catalogue (120+ pages) with zero 429s -- avoids
//: tripping it in the first place, which is cheaper and more reliable than
//: recovering from it after the fact. Configurable (see `configSchema`
//: below) since a different deployment may sit behind a different network
//: path to ntv.st and need more, or could afford less.
const DEFAULT_CHANNEL_PAGE_PACING_MS = 250;

async function fetchAllChannels(pacingMs: number): Promise<NtvChannel[]> {
    const all: NtvChannel[] = [];
    let offset = 0;
    let first = true;

    while (true) {
        if (!first) await new Promise((r) => setTimeout(r, pacingMs));
        first = false;

        const data = await fetchJson<GetChannelsResponse>(
            `${CHANNEL_INDEX_URL}?limit=${CHANNEL_PAGE_SIZE}&offset=${offset}`
        );
        if (!data.success) break;

        const channels = data.channels || [];
        if (channels.length === 0) break;
        all.push(...channels);

        if (!data.has_more) break;
        offset += CHANNEL_PAGE_SIZE;
    }

    return all;
}

async function buildChannels(pacingMs: number): Promise<ScrapedChannel[]> {
    const raw = await fetchAllChannels(pacingMs);
    const streams = await mapWithConcurrency(raw, CHANNEL_RESOLVE_CONCURRENCY, resolveChannelStream);

    const channels: ScrapedChannel[] = [];
    for (let i = 0; i < raw.length; i++) {
        const stream = streams[i];
        if (!stream) continue; // dlhd, unrecognised host, or a failed resolve.

        const entry = raw[i]!;
        // Same value used for both id-namespacing input and display name --
        // ntv.st has no other stable per-channel identifier in this
        // response, so the (already-unique, per-backend) resolve key
        // doubles as the id's raw segment.
        const rawId = entry.channel_url || entry.channel_name || `${i}`;

        channels.push({
            id: idFor(rawId),
            name: entry.channel_name || "Untitled",
            country: "",
            countryName: "",
            countryFlag: "",
            categories: [],
            languages: [],
            logo: entry.channel_image || "",
            website: "",
            network: "",
            streams: [stream],
        });
    }

    return channels;
}

// --- live events rail --------------------------------------------------------

interface NtvMatch {
    id?: string;
    title?: string;
    category?: string;
}

interface GetMatchesResponse {
    success?: boolean;
    live?: NtvMatch[];
    categories?: string[];
}

/** The bare stream URL(s) for one live event. In testing this was always a
 *  single URL regardless of how many entries the match's own `sources`
 *  list carried -- ntv.st's `/watch/` page already picks one before
 *  minting the embed token -- but this returns a list in case a future
 *  deployment exposes more than one. */
async function resolveMatchStreamUrls(server: string, match: NtvMatch): Promise<string[]> {
    if (!match.id) return [];

    const watchPage = await fetchText(`https://ntv.st/watch/${server}/${match.id}`);
    const tokenMatch = EMBED_TOKEN_RE.exec(watchPage);
    if (!tokenMatch) return [];

    const embedPage = await fetchText(`https://ntv.st/${tokenMatch[0]}`);
    const srcMatch = STREAM_IFRAME_SRC_RE.exec(embedPage);
    if (!srcMatch) return [];

    const streamUrl = extractLivelive24StreamUrl(srcMatch[1]!);
    if (streamUrl) return [streamUrl];

    // Not a livelive24.com destination this scraper knows how to unwrap
    // (most often `embed.st`, the same unsolved backend as `dlhd` -- see
    // the module docstring). Dropped rather than handed back as an
    // unplayable embed page: this surface expects a bare stream URL per
    // `ScrapedStream.url`, unlike the DirectScraper version of this file.
    return [];
}

//: Bounds how many event resolves (each a two-hop /watch -> /embed chain)
//: run at once.
const MATCH_RESOLVE_CONCURRENCY = 8;

interface EventChannel {
    channel: ScrapedChannel;
    category: string;
}

async function buildEventsRail(server: string = DEFAULT_MATCH_SERVER): Promise<{
    channels: ScrapedChannel[];
    rails: ScrapedRail[];
}> {
    const data = await fetchJson<GetMatchesResponse>(
        `${MATCH_INDEX_URL}?server=${server}&type=both`
    );
    if (!data.success) return { channels: [], rails: [] };

    const matches = data.live || [];
    const urlsByMatch = await mapWithConcurrency(matches, MATCH_RESOLVE_CONCURRENCY, (match) =>
        resolveMatchStreamUrls(server, match).catch(() => [])
    );

    const eventChannels: EventChannel[] = [];
    for (let i = 0; i < matches.length; i++) {
        const urls = urlsByMatch[i]!;
        if (urls.length === 0) continue;

        const match = matches[i]!;
        const category = match.category || "uncategorized";
        eventChannels.push({
            category,
            channel: {
                id: idFor(`event:${server}:${match.id}`),
                name: match.title || "Untitled",
                country: "",
                countryName: "",
                countryFlag: "",
                categories: [category],
                languages: [],
                logo: "",
                website: "",
                network: "",
                streams: urls.map((url) => ({
                    url,
                    quality: "",
                    labels: ["Live event"],
                    referrer: "",
                    userAgent: BROWSER_UA,
                })),
            },
        });
    }

    const idsByCategory = new Map<string, string[]>();
    for (const { category, channel } of eventChannels) {
        const list = idsByCategory.get(category) || [];
        list.push(channel.id);
        idsByCategory.set(category, list);
    }

    const rails: ScrapedRail[] = [];
    for (const category of data.categories || []) {
        const channelIds = idsByCategory.get(category);
        if (!channelIds || channelIds.length === 0) continue;
        rails.push({
            // Rail ids only need to be unique within this scraper; the
            // category name itself, slugified, is stable across rebuilds.
            id: `events-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40),
            heading: category,
            channelIds,
        });
    }

    return { channels: eventChannels.map((e) => e.channel), rails };
}

// --- entry point -----------------------------------------------------------

/**
 * User-settable knobs, shown in Settings > Live TV > Sources next to a gear
 * icon beside "NTVSTREAM" once this is imported. The two intervals are the
 * reason `tasks` below exists at all: the full channel list is large and
 * slow to rebuild, so it defaults to twice a day, while the live-events
 * rail is cheap and time-sensitive (a fixture can start mid-day), so it
 * defaults to hourly -- independently refreshable, on the schedule each one
 * actually needs.
 */
const configSchema: ScraperConfigField[] = [
    {
        key: "channelsIntervalMinutes",
        label: "Channel list refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 30,
        help: "How often the full 24/7 channel catalogue is re-scraped. This is the slow, expensive fetch -- there is rarely a reason to run it more than a couple of times a day."
    },
    {
        key: "eventsIntervalMinutes",
        label: "Live events refresh interval (minutes)",
        type: "number",
        default: 60,
        min: 5,
        help: "How often the live sporting-events rail is refreshed. Kept separate from the channel list above since fixtures start and end throughout the day."
    },
    {
        key: "pagePacingMs",
        label: "Channel-list page pacing (ms)",
        type: "number",
        default: DEFAULT_CHANNEL_PAGE_PACING_MS,
        min: 0,
        max: 5000,
        help: "Delay between channel-list page requests. Confirmed empirically that 250ms clears the whole catalogue with zero 429s from ntv.st's rate limiter -- lower this only if a specific deployment's network path can safely go faster."
    }
];

/*
    A CACHE, NOT A RE-FETCH ON EVERY CALL.

    build() used to fetch both halves fresh every time it ran. Now that each
    half has its OWN task and its OWN refresh interval (see configSchema
    above), build() instead reads whatever the tasks last put here --
    populating either half itself, on first use, if a task has not run yet
    (e.g. right after this scraper is first loaded, before the host's
    scheduler's first tick).
*/
let channelsCache: ScrapedChannel[] | null = null;
let eventsCache: { channels: ScrapedChannel[]; rails: ScrapedRail[] } | null = null;

const tasks: ScraperTask[] = [
    {
        id: "channels",
        label: "Refresh channel list",
        intervalConfigKey: "channelsIntervalMinutes",
        async run(ctx) {
            const pacingMs = Number(ctx.config.pagePacingMs ?? DEFAULT_CHANNEL_PAGE_PACING_MS);

            channelsCache = await buildChannels(pacingMs);
        }
    },
    {
        id: "events",
        label: "Refresh live events",
        intervalConfigKey: "eventsIntervalMinutes",
        async run() {
            eventsCache = await buildEventsRail();
        }
    }
];

async function build(): Promise<ScrapedCatalogue> {
    // Sequential, not Promise.all, when both are missing: both hit ntv.st's
    // own host, and running them concurrently doubles the request pressure
    // that trips its rate limiter (see pagePacingMs above) for no real time
    // saved -- buildEventsRail's own request volume is small next to
    // buildChannels'.
    if (!channelsCache) channelsCache = await buildChannels(DEFAULT_CHANNEL_PAGE_PACING_MS);
    if (!eventsCache) eventsCache = await buildEventsRail();

    return {
        channels: [...channelsCache, ...eventsCache.channels],
        rails: eventsCache.rails
    };
}

export const ntvStScraper: Scraper = {
    id: SCRAPER_ID,
    name: "NTVSTREAM",
    version: "1.2.0",
    configSchema,
    tasks,
    build
};

// -------------------------------------------------------------------------
// Manual test: `npx tsx scrapers/ntvst.mts`
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
