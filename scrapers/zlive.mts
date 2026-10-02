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
 * zlive's live-SPORTING-EVENTS feed, a separate catalogue from the 24/7
 * channels above, merged into the shared "Live Events" rail (see
 * `buildEventsRail` below; matches ntvst.mts's own rail of the same name).
 * Confirmed genuine (not zlive's catch-all decoy -- any unrecognised GET
 * path 302s to a fixed dummy `.m3u8`, `POST /streams` instead answers
 * `200 []` with real CORS headers scoped to `https://zlive.st`) but every
 * request made against it during development returned an empty array --
 * apparently no sporting event was live at the time -- so each entry's own
 * field names are inferred from the channel feed's conventions (the only
 * ground truth available on this site) rather than confirmed against a
 * real populated response. `parseEvent` below reads every plausible alias
 * for each field so a shape that turns out slightly different still
 * degrades to a blander card instead of dropping the event, and `sources`
 * is resolved through the exact same `/resolve` call channels use, since
 * both hang off the same backend and neither the docstring nor the bundle
 * gave any sign events resolve differently.
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

const SCRAPER_ID = "zlive";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: `fetch` resolves on
    // headers, and the caller's body read (`.text()`/`.json()`) still needs
    // this signal armed, or a server that stalls mid-body hangs forever.
    // `unref` keeps the pending timer from holding the process open.
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();
    try {
        return await work(controller.signal);
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
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

async function fetchChannels(): Promise<ScrapedChannel[]> {
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

    return resolved.filter((channel): channel is ScrapedChannel => channel !== null);
}

// --- live events rail -------------------------------------------------------

/** Every plausible field name for one `/streams` entry -- see the module
 *  docstring for why this is inferred rather than confirmed. Nothing here
 *  is required; `parseEvent` falls back sensibly on every field. */
interface ZliveEvent {
    id?: string | number;
    key?: string;
    slug?: string;
    title?: string;
    name?: string;
    match?: string;
    home?: string;
    away?: string;
    homeTeam?: string;
    awayTeam?: string;
    teams?: { home?: string | { name?: string }; away?: string | { name?: string } };
    category?: string;
    sport?: string;
    league?: string;
    quality?: string;
    tagline?: string;
    sources?: Array<{ key: string; label?: string }>;
}

function teamName(side: string | { name?: string } | undefined): string {
    if (!side) return "";
    return typeof side === "string" ? side : side.name || "";
}

function eventTitle(entry: ZliveEvent): string {
    if (entry.title || entry.name || entry.match) return entry.title || entry.name || entry.match || "";

    const home = entry.home || entry.homeTeam || teamName(entry.teams?.home);
    const away = entry.away || entry.awayTeam || teamName(entry.teams?.away);
    if (home && away) return `${home} vs ${away}`;

    return "Live event";
}

async function fetchLiveEvents(signal: AbortSignal): Promise<ZliveEvent[]> {
    const envelope = await encryptEnvelope({ t: Math.floor(Date.now() / 1000) });
    const response = await fetch(`${BASE}/streams`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, Referer: REFERRER },
        body: JSON.stringify(envelope)
    });
    if (!response.ok) throw new Error(`/streams -> ${response.status}`);
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as ZliveEvent[]) : [];
}

async function buildEventsRail(): Promise<{ channels: ScrapedChannel[]; rails: ScrapedRail[] }> {
    const events = await withTimeout((signal) => fetchLiveEvents(signal));
    if (!events.length) return { channels: [], rails: [] };

    const resolved = await mapWithConcurrency(events, 8, async (entry) => {
        const source = entry.sources?.[0];
        if (!source) return null;

        const url = await withTimeout((signal) => resolveSourceKey(source.key, signal), 15_000).catch(() => null);
        if (!url) return null;

        const category = entry.category || entry.sport || entry.league || "uncategorized";
        const rawId = entry.id ?? entry.key ?? entry.slug ?? eventTitle(entry);
        const channel: ScrapedChannel = {
            id: idFor(`event:${rawId}`),
            name: eventTitle(entry),
            country: "",
            countryName: "",
            countryFlag: "",
            categories: [category],
            languages: [],
            logo: "",
            website: "",
            network: "",
            streams: [
                {
                    url,
                    quality: entry.quality || "",
                    labels: entry.tagline ? [entry.tagline] : ["Live event"],
                    referrer: REFERRER,
                    userAgent: USER_AGENT
                }
            ]
        };
        return channel;
    });

    const channels = resolved.filter((channel): channel is ScrapedChannel => channel !== null);
    if (!channels.length) return { channels: [], rails: [] };

    // Same rail name ntvst.mts uses -- the host merges any two scrapers'
    // rails whose headings match, so this lands in the same "Live Events"
    // rail rather than a separate one.
    return { channels, rails: [{ id: "live-events", heading: "Live Events", channelIds: channels.map((c) => c.id), group: "Live events" }] };
}

async function build(): Promise<ScrapedCatalogue> {
    const [channels, events] = await Promise.all([
        fetchChannels(),
        buildEventsRail().catch((cause) => {
            console.error("zlive: live-events rail failed", cause);
            return { channels: [], rails: [] };
        })
    ]);

    return { channels: [...channels, ...events.channels], rails: [...events.rails, ...railsFor(channels, SCRAPER_ID, "zlive.st")] };
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
const CONTINENTS: [string, string][] = [
    ["Asia", "AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE AE"],
    ["Europe", "AD AL AT BA BE BG BY CH CZ DE DK EE ES FI FO FR GB UK GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK"],
    ["Africa", "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW RE"],
    ["North America", "US CA MX GL BM"],
    ["Latin America & Caribbean", "AG AI AR AW BB BO BQ BR BS BZ CL CO CR CU CW DM DO EC GD GT GY HN HT JM KN KY LC NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI MQ GP GF"],
    ["Oceania", "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS"]
];

function continentName(code: string): string {
    return CONTINENTS.find(([, codes]) => codes.split(" ").includes(code.toUpperCase()))?.[0] || "Elsewhere";
}

function languageTitle(code: string): string {
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);

        return name && name !== code ? name : code.toUpperCase();
    } catch {
        return code.toUpperCase();
    }
}

/** Words the host's own genre rails (News, Sports, Movies ...) already carry under the same name. */
const GENRE_NAMES = new Set([
    "news", "sports", "movies", "kids", "music", "documentary", "lifestyle", "business", "entertainment", "general"
]);

/** Never offered as a rail: shopping and adult shelves. */
const UNLISTED = /\b(shop\w*|xxx|adult|erotic\w*|sinnlich\w*|telesales|18\+)\b/i;

function railsFor(channels: ScrapedChannel[], sourceId: string, sourceName: string, wanted = { countries: true, languages: true, categories: true }): ScrapedRail[] {
    const rails: ScrapedRail[] = [];
    const perCountry = new Map<string, { n: number; names: Map<string, number> }>();
    const perLanguage = new Map<string, number>();
    const perWord = new Map<string, number>();

    for (const channel of channels) {
        if (channel.country) {
            const entry = perCountry.get(channel.country) || { n: 0, names: new Map<string, number>() };

            entry.n += 1;
            if (channel.countryName) entry.names.set(channel.countryName, (entry.names.get(channel.countryName) || 0) + 1);
            perCountry.set(channel.country, entry);
        }

        for (const code of new Set(channel.languages)) perLanguage.set(code, (perLanguage.get(code) || 0) + 1);
        for (const word of new Set(channel.categories)) perWord.set(word, (perWord.get(word) || 0) + 1);
    }

    function byCount<T>(a: [string, T], b: [string, T], size: (value: T) => number): number {
        return size(b[1]) - size(a[1]) || a[0].localeCompare(b[0]);
    }

    if (wanted.countries) {
        for (const [code, entry] of [...perCountry.entries()].sort((a, b) => byCount(a, b, (v) => v.n))) {
            const name = [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

            if (!name || !/^[A-Za-z]{2,3}$/.test(code)) continue;

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
            if (!/^[a-z]{2,3}$/.test(code)) continue;

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
        const taken = new Set<string>();
        let added = 0;

        for (const [word, count] of [...perWord.entries()].sort((a, b) => byCount(a, b, (v) => v))) {
            const slug = `cat-${word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");

            if (count < 3 || word.length > 40 || GENRE_NAMES.has(word) || UNLISTED.test(word) || slug === "cat" || taken.has(slug)) continue;

            taken.add(slug);
            rails.push({
                id: slug,
                heading: word.replace(/(^|[\s(+&/-])(\p{L})/gu, (_all, lead: string, first: string) => lead + first.toUpperCase()).replace(/\bTv\b/g, "TV"),
                by: "Its own category",
                group: "Categories",
                channelIds: [],
                filter: { categories: [word] }
            });

            added += 1;
            if (added >= 60) break;
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

export const zliveScraper: Scraper = {
    id: SCRAPER_ID,
    name: "zlive.st",
    version: "1.2.0",
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
