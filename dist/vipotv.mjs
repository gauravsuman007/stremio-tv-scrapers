/**
 * vipotv.com -- a WordPress live-TV directory, ~1.2k resolvable channels across
 * ~200 country categories (strong on India, Germany, Brazil, Italy,
 * Greece, Iran). About 60% of a 25-channel sample were stream URLs
 * iptv-org does not list.
 *
 *   1. The WordPress REST API (`/wp-json/wp/v2/posts`, `/categories`)
 *      lists every post with its title, link and category ids; categories
 *      are countries. Posts in "Publicity" are SEO articles, not channels,
 *      and are skipped up front.
 *   2. The stream is NOT in the post body the API returns -- only the
 *      rendered page carries it, as an iframe to
 *      `livetv.work/fireplayer/video/<32-hex hash>` (a FirePlayer install).
 *      Pages with no such iframe (YouTube-only channels) are skipped.
 *   3. `POST livetv.work/fireplayer/video/<hash>?do=getVideo` with form
 *      body `hash=<hash>&r=<referring page>&s=` and `X-Requested-With:
 *      XMLHttpRequest` answers `{ videoSources: [{ file, label, type }] }`
 *      with the plain, broadcaster-hosted `.m3u8` -- no signing. Some
 *      answer `{ videoSrc }` instead, pointing at another livetv.work PHP
 *      player page rather than a stream; those are skipped.
 *
 * Two requests per channel (~3k per build), run 8 at a time. The site's
 * pages are uncached and take 5-11s each, so a build takes ~15-20 minutes
 * (16 min measured 2026-09-30, 1230 channels). Liveness
 * across the directory is mixed, as with any user-maintained list -- the
 * host's own nightly check drops the dead ones.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
const SCRAPER_ID = "vipotv";
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
const BASE = "https://vipotv.com";
const PLAYER = "https://livetv.work/fireplayer/video";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
async function get(url) {
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": UA } }));
    if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
    return response;
}
/** Walks every page of a WordPress collection endpoint. */
async function wpAll(path) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
        const response = await withTimeout((signal) => fetch(`${BASE}/wp-json/wp/v2/${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, {
            signal,
            headers: { "User-Agent": UA }
        }));
        // WordPress answers 400 for a page past the end.
        if (response.status === 400)
            break;
        if (!response.ok)
            throw new Error(`vipotv: ${path} page ${page} -> ${response.status}`);
        const batch = (await response.json());
        items.push(...batch);
        const totalPages = Number(response.headers.get("x-wp-totalpages") || "0");
        if (!batch.length || (totalPages && page >= totalPages))
            break;
    }
    return items;
}
function decodeEntities(text) {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
const COUNTRY_CODES = (() => {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const map = new Map();
    for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
            const code = String.fromCharCode(a, b);
            try {
                const name = names.of(code);
                if (name && name !== code)
                    map.set(name.toLowerCase(), code);
            }
            catch {
                // not a region code
            }
        }
    }
    // The site's own spellings that ICU words differently.
    map.set("usa", "US");
    map.set("uk", "GB");
    map.set("czechia", "CZ");
    map.set("bosnia herzegovina", "BA");
    map.set("democratic congo", "CD");
    map.set("iranian", "IR");
    return map;
})();
function flagEmoji(code) {
    if (!/^[A-Z]{2}$/.test(code))
        return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
async function resolveHash(hash, referrer) {
    const response = await withTimeout((signal) => fetch(`${PLAYER}/${hash}?do=getVideo`, {
        method: "POST",
        signal,
        headers: {
            "User-Agent": UA,
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Referer: `${PLAYER}/${hash}`
        },
        body: new URLSearchParams({ hash, r: referrer, s: "" }).toString()
    }));
    if (!response.ok)
        return null;
    const body = (await response.json());
    const file = (body.videoSources || []).map((s) => s.file || "").find((f) => /^https?:\/\//.test(f));
    return file || null;
}
async function build() {
    const categories = await wpAll("categories?_fields=id,name");
    const categoryNames = new Map(categories.map((c) => [c.id, decodeEntities(c.name || "")]));
    const skipCategories = new Set(categories.filter((c) => /publicity|blog|news-article/i.test(c.name || "")).map((c) => c.id));
    const posts = (await wpAll("posts?_fields=slug,link,title,categories")).filter((p) => p.slug && p.link && !(p.categories || []).some((c) => skipCategories.has(c)));
    if (!posts.length)
        throw new Error("vipotv: no posts listed");
    let failures = 0;
    const results = await mapWithConcurrency(posts, 8, async (post) => {
        try {
            const html = await (await get(post.link)).text();
            const hash = html.match(/livetv\.work\/fireplayer\/video\/([0-9a-f]{32})/)?.[1];
            if (!hash)
                return null;
            const url = await resolveHash(hash, `${BASE}/`);
            if (!url)
                return null;
            const name = decodeEntities(post.title?.rendered || "").trim();
            if (!name)
                return null;
            const countryName = categoryNames.get((post.categories || [])[0] ?? -1) || "";
            const country = COUNTRY_CODES.get(countryName.toLowerCase()) || "";
            const logo = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "";
            return {
                id: idFor(post.slug),
                name,
                country,
                countryName: country ? countryName : "",
                countryFlag: flagEmoji(country),
                categories: [],
                languages: [],
                // The site's own generic og:image stands in when a post has no logo.
                logo: /\.svg(\?|$)|vipotv_live_tv/i.test(logo) ? "" : decodeEntities(logo),
                website: post.link,
                network: "",
                streams: [{ url, quality: "", labels: [], referrer: "", userAgent: "" }]
            };
        }
        catch {
            failures++;
            return null;
        }
    });
    if (failures > posts.length / 2)
        throw new Error(`vipotv: ${failures}/${posts.length} channels failed`);
    const channels = results.filter((c) => c !== null);
    if (!channels.length)
        throw new Error("vipotv: no channel resolved to a stream");
    return { channels };
}
export const vipotvScraper = {
    id: SCRAPER_ID,
    name: "vipotv",
    version: "1.0.0",
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/vipotv.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
        console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
        console.log(`${catalogue.channels.filter((c) => c.country).length} with a country code`);
        console.log(catalogue.channels[0] || "(none)");
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
