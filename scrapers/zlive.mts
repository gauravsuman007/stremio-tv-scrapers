/**
 * zlive.st -- a ~200-channel 24/7 live-TV aggregator.
 *
 * The catalogue itself is a single plain, unauthenticated JSON document:
 * `GET https://iptv.zlive.st/channels.json` returns every channel with an
 * `id`, display fields (`name`, `region`, `flag`, `sport`, `quality`) and a
 * `sources: [{ key, label }]` array -- `key` is an opaque per-channel
 * identifier, never a playable URL by itself.
 *
 * Turning a `key` into a real stream URL needs a second call,
 * `POST https://iptv.zlive.st/resolve`, and THAT call is gated behind a
 * real (not merely obfuscated) crypto scheme -- confirmed by running the
 * site's own minified bundle in a Node `vm` sandbox with browser globals
 * stubbed (`crypto.webcrypto`, `TextEncoder`, a `fetch` stub that throws so
 * the exact request could be read out of the exception) and, separately,
 * instrumenting `crypto.subtle.digest`/`encrypt` to log their real
 * arguments -- the same "run it, don't hand-decode it" approach
 * AGENTS.md's WASM section describes, applied to obfuscated JS instead:
 *
 *   1. `key = SHA-256("<local YYYY-MM-DD>|<fixed salt>v3")`, where the salt
 *      is the constant `ZLIVE_SALT` below (an XOR-obfuscated byte array in
 *      the bundle, decoded once and inlined here -- it is not a secret
 *      derived from anything request-specific, just a fixed string glued
 *      into the digest input).
 *   2. That digest is imported directly as a raw 256-bit AES-GCM key (no
 *      HKDF, no PBKDF2 -- the digest bytes themselves are the key).
 *   3. A random 12-byte IV encrypts `JSON.stringify({ c: <source key>,
 *      t: <unix seconds> })`; AES-GCM's trailing 16-byte tag is split off
 *      the ciphertext and both are base64'd separately.
 *   4. The request body is `{ p: <ciphertext b64>, n: <iv b64>,
 *      g: <tag b64>, k: "<the same YYYY-MM-DD used for the key> }`.
 *
 * `resolve()` answers `{ location: <url> }` -- sometimes a direct CDN
 * `.m3u8` (`epidd.hundxvision.co.uk/main/secure/<hash>/<ts>/<slug>.m3u8`),
 * sometimes a same-shape proxy (`route.transcode.cfd/m3u8-proxy.m3u8?
 * data=<opaque>`) whose own child playlists/segments are further
 * `route.transcode.cfd` URLs of the same kind. Both were confirmed to
 * fetch and play (real `#EXTM3U`/`#EXTINF` content, not a decoy) -- this is
 * a URL-obfuscation proxy, not the segment-level steganography ntv.st's
 * `dlhd` backend uses (see that scraper's docstring); a plain HLS client
 * follows it with no special handling. Every URL from either shape needs
 * `Referer: https://zlive.st/` and a browser-like `User-Agent` -- a bare
 * request without both 403s/404s.
 *
 * The site also exposes a `POST /streams` endpoint using the exact same
 * crypto envelope (body `{ t: <unix seconds> }` only, no channel key) --
 * that one is zlive's live-SPORTING-EVENTS feed, an entirely separate
 * catalogue from the 24/7 channels above. Not scraped here: it is a much
 * smaller, mostly-fixture-based feed better suited to its own scraper if
 * ever wanted, and mixing it into this one would blur "channel" vs
 * "one-off event" for no benefit.
 *
 * A `key` that already looks like `http(s)://...` is used as-is (the
 * site's own code checks this before ever calling `/resolve` -- some
 * sources may be configured as direct links with no resolve step).
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

const SCRAPER_ID = "zlive";

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
 *  each channel needs its own `/resolve` round-trip, and doing ~200 of
 *  those fully in parallel is an unnecessary burst against one host. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function run(): Promise<void> {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index] as T);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
    return results;
}

const BASE = "https://iptv.zlive.st";
const REFERRER = "https://zlive.st/";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** XOR-decoded once from the bundle's obfuscated `Ry`/`Py` byte arrays
 *  (`Ny(Ry, Py)` in the site's own minified code) -- see the module
 *  docstring for how this was recovered. Fixed, not request-specific. */
const ZLIVE_SALT = "J7dRYVTWoySiukvBBY5hXvMvBdBZ_b08wBYlz_BrSXg";

/** The literal suffix the site's own `Rg()` appends after the salt before
 *  hashing -- confirmed by logging `crypto.subtle.digest`'s real input. */
const ZLIVE_KEY_VERSION = "v3";

interface ZliveChannel {
    id: string;
    name: string;
    tagline?: string;
    region?: string;
    flag?: string;
    quality?: string;
    live?: boolean;
    sport?: string;
    sources: Array<{ key: string; label?: string }>;
}

/** Reproduces zlive.st's own `Oy(new Date)` -- a LOCAL calendar date,
 *  `YYYY-MM-DD`. The server accepts requests keyed to "today" at day
 *  granularity; using UTC here (rather than the scraper host's local zone,
 *  which a browser would use instead) keeps this correct regardless of
 *  what timezone the container happens to run in, at the cost of a
 *  possible single failed request right at UTC midnight if zlive's own
 *  server clock disagrees -- an acceptable trade for a scraper with no
 *  fixed locale of its own. */
function todayKeyDate(): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/** The site's `Rg()`: derives an AES-GCM key from today's date plus the
 *  fixed salt, then encrypts `payload` under a fresh random IV. Returns
 *  exactly the four fields zlive's `/streams` and `/resolve` endpoints
 *  expect in their request body. */
async function encryptEnvelope(payload: unknown): Promise<{ p: string; n: string; g: string; k: string }> {
    const dateKey = todayKeyDate();
    const digestInput = new TextEncoder().encode(`${dateKey}|${ZLIVE_SALT}${ZLIVE_KEY_VERSION}`);
    const keyBytes = await crypto.subtle.digest("SHA-256", digestInput);
    const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));

    const tagStart = encrypted.length - 16;
    return {
        p: Buffer.from(encrypted.slice(0, tagStart)).toString("base64"),
        n: Buffer.from(iv).toString("base64"),
        g: Buffer.from(encrypted.slice(tagStart)).toString("base64"),
        k: dateKey
    };
}

async function fetchChannelList(signal: AbortSignal): Promise<ZliveChannel[]> {
    const response = await fetch(`${BASE}/channels.json`, {
        signal,
        headers: { "User-Agent": USER_AGENT, Referer: REFERRER }
    });
    if (!response.ok) throw new Error(`channels.json -> ${response.status}`);
    return (await response.json()) as ZliveChannel[];
}

/** Turns one channel's opaque `sources[].key` into a real stream URL via
 *  `POST /resolve`. Returns `null` rather than throwing on a single
 *  channel's failure -- one dead upstream key should not fail the whole
 *  catalogue, matching how `cdnlive`/`hesgoales` failures are handled in
 *  ntvst.mts. */
async function resolveSourceKey(key: string, signal: AbortSignal): Promise<string | null> {
    if (/^https?:\/\//i.test(key)) return key;

    try {
        const envelope = await encryptEnvelope({ c: key, t: Math.floor(Date.now() / 1000) });
        const response = await fetch(`${BASE}/resolve`, {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, Referer: REFERRER },
            body: JSON.stringify(envelope)
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { location?: string };
        return body.location || null;
    } catch {
        return null;
    }
}

/** zlive's own `flag` field is already a lowercase ISO 3166-1 alpha-2 code
 *  (`"gb"`, `"us"`, ...) or `""` -- converting it to the flag emoji is just
 *  offsetting each letter into the Unicode regional-indicator block. */
function flagEmoji(countryCode: string): string {
    if (!/^[a-z]{2}$/i.test(countryCode)) return "";
    const codePoints = [...countryCode.toUpperCase()].map((letter) => 0x1f1e6 + (letter.charCodeAt(0) - 65));
    return String.fromCodePoint(...codePoints);
}

function categoriesFor(sport: string | undefined): string[] {
    if (!sport) return [];
    return [sport.toLowerCase()];
}

async function build(): Promise<ScrapedCatalogue> {
    const rawChannels = await withTimeout((signal) => fetchChannelList(signal));

    const resolved = await mapWithConcurrency(rawChannels, 8, async (entry) => {
        const source = entry.sources[0];
        if (!source) return null;

        const url = await withTimeout((signal) => resolveSourceKey(source.key, signal), 15_000);
        if (!url) return null;

        const country = (entry.flag || "").toUpperCase();
        const channel: ScrapedChannel = {
            id: idFor(entry.id),
            name: entry.name,
            country,
            countryName: entry.region || country,
            countryFlag: flagEmoji(entry.flag || ""),
            categories: categoriesFor(entry.sport),
            languages: [],
            logo: "",
            website: "",
            network: "",
            streams: [
                {
                    url,
                    quality: entry.quality || "",
                    labels: entry.tagline ? [entry.tagline] : [],
                    referrer: REFERRER,
                    userAgent: USER_AGENT
                }
            ]
        };
        return channel;
    });

    const channels = resolved.filter((channel): channel is ScrapedChannel => channel !== null);

    return { channels };
}

export const zliveScraper: Scraper = {
    id: SCRAPER_ID,
    name: "zlive.st",
    version: "1.0.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/zlive.mts` -- prints a channel count and the first
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
