/**
 * vavoo.to -- ~10k European/Middle-Eastern live-TV entries, and the same
 * catalogue re-skinned under `kool.to`/`kool.ws`, `huhu.to` and `oha.to`.
 *
 * All four sites are the same "MediaHubMX" web player pointed at an addon
 * on their own origin. vavoo/kool expose it as the `mediahubmx` engine,
 * huhu/oha as the older `mediaurl` engine; channel ids, names and the
 * resolved stream servers are identical across all four (verified
 * 2026-09-30), so this one scraper covers the whole family and the others
 * are only fallbacks if vavoo.to itself is down.
 *
 *   1. `POST /mediahubmx-catalog.json` (`User-Agent: MediaHubMX/2`, JSON
 *      body with `catalogId: "iptv"`, a `filter.group` and a `cursor`)
 *      pages 300 items at a time. An empty filter silently means
 *      "Germany", so every group named in the first response's
 *      `features.filter` has to be walked separately.
 *   2. Each item's `url` (`https://vavoo.to/vavoo-iptv/play/<id>`) is NOT
 *      playable -- it 404s. `POST /mediahubmx-resolve.json` with that url
 *      answers `[{ url }]`: a plain-HTTP `http://<ip>:8008/sunshine/
 *      <opaque token>/hls/index.m3u8` that plays with no headers at all.
 *      No signature is needed from a web client (the native apps' signed
 *      `addonSig` ping is only required for the native "proxy" features).
 *
 * The resolved token is opaque (encrypted, so its lifetime can't be read
 * off it) -- a URL was confirmed still playing ~55 minutes after being
 * resolved; the real lifetime is unknown. If it turns out shorter than
 * the host's twelve-hour rebuild, entries will go stale between rebuilds
 * and this should move to a shorter-interval task (see showroom.mts).
 *
 * The same channel usually appears several times with a suffix naming its
 * upstream (`"ZDF .c"`, `"ZDF HD .b"`, `"ZDF |H"` on huhu); those are
 * folded into ONE channel per (group, cleaned name) with every copy as a
 * separate mirror stream.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
const SCRAPER_ID = "vavoo";
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
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
        for (;;) {
            const index = next++;
            if (index >= items.length)
                return;
            results[index] = await worker(items[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
    return results;
}
/** Tried in order; the first one whose catalogue answers is used for
 *  every request in this build. */
const HOSTS = [
    { base: "https://vavoo.to", engine: "mediahubmx" },
    { base: "https://kool.to", engine: "mediahubmx" },
    { base: "https://huhu.to", engine: "mediaurl" },
    { base: "https://oha.to", engine: "mediaurl" }
];
/** Group name -> ISO country code and ISO 639-3 language. Groups that
 *  span several countries ("Arabia", "Balkans") get no country. */
const GROUPS = {
    Albania: { country: "AL", language: "sqi" },
    Arabia: { country: "", language: "ara" },
    Balkans: { country: "", language: "" },
    Bulgaria: { country: "BG", language: "bul" },
    Croatia: { country: "HR", language: "hrv" },
    France: { country: "FR", language: "fra" },
    "France Sport": { country: "FR", language: "fra", category: "sports" },
    Germany: { country: "DE", language: "deu" },
    Italy: { country: "IT", language: "ita" },
    Netherlands: { country: "NL", language: "nld" },
    Poland: { country: "PL", language: "pol" },
    Portugal: { country: "PT", language: "por" },
    Romania: { country: "RO", language: "ron" },
    Russia: { country: "RU", language: "rus" },
    Spain: { country: "ES", language: "spa" },
    Turkey: { country: "TR", language: "tur" },
    "United Kingdom": { country: "GB", language: "eng" }
};
async function post(host, action, body) {
    const response = await withTimeout((signal) => fetch(`${host.base}/${host.engine}-${action}.json`, {
        method: "POST",
        signal,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": host.engine === "mediahubmx" ? "MediaHubMX/2" : "MediaUrl/2"
        },
        body: JSON.stringify({ language: "de", region: "AT", clientVersion: "3.0.2", ...body })
    }));
    if (!response.ok)
        throw new Error(`${host.base} ${action} -> ${response.status}`);
    return (await response.json());
}
function catalogPage(host, group, cursor) {
    return post(host, "catalog", {
        catalogId: "iptv",
        id: "iptv",
        adult: false,
        search: "",
        sort: "name",
        filter: group ? { group } : {},
        cursor
    });
}
async function pickHost() {
    const errors = [];
    for (const host of HOSTS) {
        try {
            const first = await catalogPage(host, "", 0);
            const groups = first.features?.filter?.find((f) => f.id === "group")?.values || [];
            if (groups.length)
                return { host, groups };
            errors.push(`${host.base}: no groups`);
        }
        catch (cause) {
            errors.push(String(cause));
        }
    }
    throw new Error(`vavoo: every host failed -- ${errors.join("; ")}`);
}
async function listGroup(host, group) {
    const items = [];
    let cursor = 0;
    // Bounded, in case a server ever stops advancing its cursor.
    for (let page = 0; cursor !== null && cursor !== undefined && page < 100; page++) {
        const result = await catalogPage(host, group, cursor);
        items.push(...(result.items || []));
        cursor = result.nextCursor;
    }
    return items;
}
async function resolve(host, url) {
    try {
        const result = await post(host, "resolve", { url });
        const resolved = result[0]?.url;
        return resolved && /^https?:\/\//.test(resolved) ? resolved : null;
    }
    catch {
        return null;
    }
}
/** `"ZDF HD .c"` / `"ZDF |H"` -> `"ZDF"`. */
function cleanName(raw) {
    return raw
        .replace(/\s+(\.[a-z0-9]{1,3}|\|[A-Z0-9]{1,3})\s*$/i, "")
        .replace(/\s+\((backup|[0-9]+)\)\s*$/i, "")
        .replace(/\s+(FHD|UHD|HD|SD|4K|HEVC|H265|RAW)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}
function qualityOf(raw) {
    if (/\b(UHD|4K)\b/i.test(raw))
        return "4K";
    if (/\bFHD\b/i.test(raw))
        return "1080p";
    if (/\bHD\b/i.test(raw))
        return "720p";
    return "";
}
function slug(text) {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}
function flagEmoji(code) {
    if (!/^[A-Z]{2}$/.test(code))
        return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
async function build() {
    const { host, groups } = await pickHost();
    const perGroup = await mapWithConcurrency(groups, 4, async (group) => ({
        group,
        items: await listGroup(host, group).catch((cause) => {
            console.error(`vavoo: group ${group} failed`, cause);
            return [];
        })
    }));
    const flat = perGroup.flatMap(({ group, items }) => items.filter((item) => item.url && item.name).map((item) => ({ group, item })));
    if (!flat.length)
        throw new Error("vavoo: catalogue came back empty");
    const resolved = await mapWithConcurrency(flat, 24, (entry) => resolve(host, entry.item.url));
    const byKey = new Map();
    const channels = [];
    flat.forEach(({ group, item }, index) => {
        const url = resolved[index];
        if (!url)
            return;
        const name = cleanName(item.name);
        if (!name)
            return;
        const key = `${slug(group)}-${slug(name)}`;
        const stream = { url, quality: qualityOf(item.name), labels: [], referrer: "", userAgent: "" };
        const existing = byKey.get(key);
        if (existing) {
            existing.streams.push(stream);
            if (!existing.logo && item.logo)
                existing.logo = item.logo;
            return;
        }
        const meta = GROUPS[group] || { country: "", language: "" };
        const channel = {
            id: idFor(key),
            name,
            country: meta.country,
            countryName: meta.country ? group : "",
            countryFlag: flagEmoji(meta.country),
            categories: meta.category ? [meta.category] : [],
            languages: meta.language ? [meta.language] : [],
            logo: item.logo || "",
            website: "",
            network: "",
            streams: [stream]
        };
        byKey.set(key, channel);
        channels.push(channel);
    });
    if (!channels.length)
        throw new Error("vavoo: no channel resolved to a stream");
    return { channels };
}
export const vavooScraper = {
    id: SCRAPER_ID,
    name: "vavoo.to (+ kool/huhu/oha)",
    version: "1.0.0",
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/vavoo.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
        console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
        console.log(`${catalogue.channels.reduce((n, c) => n + c.streams.length, 0)} streams`);
        console.log(catalogue.channels[0] || "(none)");
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
