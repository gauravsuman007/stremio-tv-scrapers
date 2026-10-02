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
    filter?: { countries?: string[]; categories?: string[]; genres?: string[]; languages?: string[]; sources?: string[]; networks?: string[]; market?: "home-first" | "first" };
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

const SCRAPER_ID = "vipotv";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
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
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}

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

const BASE = "https://vipotv.com";
const PLAYER = "https://livetv.work/fireplayer/video";
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

interface WpPost {
    slug?: string;
    link?: string;
    title?: { rendered?: string };
    categories?: number[];
}

async function get(url: string): Promise<Response> {
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": UA } }));
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return response;
}

/** Walks every page of a WordPress collection endpoint. */
async function wpAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 100; page++) {
        const response = await withTimeout((signal) =>
            fetch(`${BASE}/wp-json/wp/v2/${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, {
                signal,
                headers: { "User-Agent": UA }
            })
        );
        // WordPress answers 400 for a page past the end.
        if (response.status === 400) break;
        if (!response.ok) throw new Error(`vipotv: ${path} page ${page} -> ${response.status}`);
        const batch = (await response.json()) as T[];
        items.push(...batch);
        const totalPages = Number(response.headers.get("x-wp-totalpages") || "0");
        if (!batch.length || (totalPages && page >= totalPages)) break;
    }
    return items;
}

function decodeEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

const COUNTRY_CODES: Map<string, string> = (() => {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const map = new Map<string, string>();
    for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
            const code = String.fromCharCode(a, b);
            try {
                const name = names.of(code);
                if (name && name !== code) map.set(name.toLowerCase(), code);
            } catch {
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

function flagEmoji(code: string): string {
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

async function resolveHash(hash: string, referrer: string): Promise<string | null> {
    const response = await withTimeout((signal) =>
        fetch(`${PLAYER}/${hash}?do=getVideo`, {
            method: "POST",
            signal,
            headers: {
                "User-Agent": UA,
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                Referer: `${PLAYER}/${hash}`
            },
            body: new URLSearchParams({ hash, r: referrer, s: "" }).toString()
        })
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { videoSources?: Array<{ file?: string }> };
    const file = (body.videoSources || []).map((s) => s.file || "").find((f) => /^https?:\/\//.test(f));
    return file || null;
}

async function build(): Promise<ScrapedCatalogue> {
    const categories = await wpAll<{ id: number; name?: string }>("categories?_fields=id,name");
    const categoryNames = new Map(categories.map((c) => [c.id, decodeEntities(c.name || "")]));
    const skipCategories = new Set(
        categories.filter((c) => /publicity|blog|news-article/i.test(c.name || "")).map((c) => c.id)
    );

    const posts = (await wpAll<WpPost>("posts?_fields=slug,link,title,categories")).filter(
        (p) => p.slug && p.link && !(p.categories || []).some((c) => skipCategories.has(c))
    );
    if (!posts.length) throw new Error("vipotv: no posts listed");

    let failures = 0;
    const results = await mapWithConcurrency(posts, 8, async (post): Promise<ScrapedChannel | null> => {
        try {
            const html = await (await get(post.link!)).text();
            const hash = html.match(/livetv\.work\/fireplayer\/video\/([0-9a-f]{32})/)?.[1];
            if (!hash) return null;
            const url = await resolveHash(hash, `${BASE}/`);
            if (!url) return null;

            const name = decodeEntities(post.title?.rendered || "").trim();
            if (!name) return null;
            const countryName = categoryNames.get((post.categories || [])[0] ?? -1) || "";
            const country = COUNTRY_CODES.get(countryName.toLowerCase()) || "";
            const logo = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "";

            return {
                id: idFor(post.slug!),
                name,
                country,
                countryName: country ? countryName : "",
                countryFlag: flagEmoji(country),
                categories: [],
                languages: [],
                // The site's own generic og:image stands in when a post has no logo.
                logo: /\.svg(\?|$)|vipotv_live_tv/i.test(logo) ? "" : decodeEntities(logo),
                website: post.link!,
                network: "",
                streams: [{ url, quality: "", labels: [], referrer: "", userAgent: "" }]
            };
        } catch {
            failures++;
            return null;
        }
    });
    if (failures > posts.length / 2) throw new Error(`vipotv: ${failures}/${posts.length} channels failed`);

    const channels = results.filter((c): c is ScrapedChannel => c !== null);
    if (!channels.length) throw new Error("vipotv: no channel resolved to a stream");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "vipotv") };
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

function railsFor(channels: ScrapedChannel[], sourceId: string, sourceName: string, wanted: { countries: boolean; languages: boolean; categories: boolean; networks?: boolean } = { countries: true, languages: true, categories: true }): ScrapedRail[] {
    const rails: ScrapedRail[] = [];
    const perCountry = new Map<string, { n: number; names: Map<string, number> }>();
    const perLanguage = new Map<string, number>();
    const perWord = new Map<string, number>();
    const perNetwork = new Map<string, { n: number; name: string }>();

    for (const channel of channels) {
        if (channel.country) {
            const entry = perCountry.get(channel.country) || { n: 0, names: new Map<string, number>() };

            entry.n += 1;
            if (channel.countryName) entry.names.set(channel.countryName, (entry.names.get(channel.countryName) || 0) + 1);
            perCountry.set(channel.country, entry);
        }

        for (const code of new Set(channel.languages)) perLanguage.set(code, (perLanguage.get(code) || 0) + 1);
        for (const word of new Set(channel.categories)) perWord.set(word, (perWord.get(word) || 0) + 1);

        const network = (channel.network || "").trim();

        if (network) {
            const key = network.toLowerCase();

            perNetwork.set(key, { n: (perNetwork.get(key)?.n || 0) + 1, name: perNetwork.get(key)?.name || network });
        }
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

    if (wanted.networks !== false) {
        let added = 0;

        for (const [key, entry] of [...perNetwork.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
            const slug = `network-${key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");

            if (entry.n < 3 || key.length < 3 || key.length > 30 || slug === "network" || UNLISTED.test(key) || /[^\p{L}\p{N} &.+'-]/u.test(key) || sourceName.toLowerCase().includes(key) || key.includes(sourceName.toLowerCase())) continue;

            rails.push({
                id: slug,
                heading: entry.name,
                by: "One network",
                group: "Networks",
                channelIds: [],
                filter: { networks: [key] }
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

export const vipotvScraper: Scraper = {
    id: SCRAPER_ID,
    name: "vipotv",
    version: "1.2.0",
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
