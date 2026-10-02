/**
 * CXtv (cxtvlive.com) -- a ~2.6k-channel user-submitted live-TV directory,
 * heavy on Brazilian/Latin-American local and religious stations. About
 * two thirds of a 30-page sample were stream URLs iptv-org does not list.
 *
 * No API. `sitemap.xml` enumerates every channel page
 * (`/live-tv/<slug>`), and each page carries its stream as a plain
 * `data-stream-url="<m3u8>"` attribute (the same URL also appears as the
 * JSON-LD VideoObject's `contentUrl`), plus the channel's name (`<h1>`),
 * logo (`og:image`), categories (`/tv/category/<x>` links) and country
 * (`/tv/country/<x>` link text). Every page has to be fetched -- country
 * and category listing pages carry no stream URLs -- so this is ~2.6k
 * small GETs per build, run 8 at a time.
 *
 * Pages whose player is an iframe/YouTube embed rather than a direct URL
 * have no usable `data-stream-url` and are skipped (~15% in the sample).
 * Stream URLs are the broadcasters' own CDNs and played with no headers
 * in the sample checked.
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

const SCRAPER_ID = "cxtv";

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

const BASE = "https://www.cxtvlive.com";
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

async function getText(url: string): Promise<string> {
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": UA } }));
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return response.text();
}

function decodeEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

/** English country name -> ISO code, built once from Node's own ICU data. */
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
    return map;
})();

function flagEmoji(code: string): string {
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function parseChannel(slug: string, html: string): ScrapedChannel | null {
    const url = html.match(/data-stream-url="([^"]+)"/)?.[1];
    if (!url) return null;
    const streamUrl = decodeEntities(url);
    if (!/^https?:\/\//.test(streamUrl) || /youtube\.com|youtu\.be/.test(streamUrl)) return null;

    const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || "";
    const name = decodeEntities(heading.replace(/<[^>]+>/g, " "))
        .replace(/\s+Live\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!name) return null;

    const categories = [...html.matchAll(/\/tv\/category\/[^"]+"[^>]*>([^<]+)</g)].map((m) =>
        decodeEntities(m[1] || "").trim().toLowerCase()
    );
    const countryName = decodeEntities(html.match(/\/tv\/country\/[^"]+">(?:<img[^>]*>)?([^<]+)</)?.[1] || "").trim();
    const country = COUNTRY_CODES.get(countryName.toLowerCase()) || "";
    const logo = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "";

    return {
        id: idFor(slug),
        name,
        country,
        countryName,
        countryFlag: flagEmoji(country),
        categories: [...new Set(categories.filter(Boolean))],
        languages: [],
        logo: decodeEntities(logo),
        website: `${BASE}/live-tv/${slug}`,
        network: "",
        streams: [{ url: streamUrl, quality: "", labels: [], referrer: "", userAgent: "" }]
    };
}

async function build(): Promise<ScrapedCatalogue> {
    const sitemap = await getText(`${BASE}/sitemap.xml`);
    const slugs = [
        ...new Set([...sitemap.matchAll(/<loc>https:\/\/www\.cxtvlive\.com\/live-tv\/([^<]+)<\/loc>/g)].map((m) => m[1]!))
    ];
    if (!slugs.length) throw new Error("cxtv: sitemap listed no channel pages");

    let failures = 0;
    const parsed = await mapWithConcurrency(slugs, 8, async (slug) => {
        try {
            return parseChannel(slug, await getText(`${BASE}/live-tv/${slug}`));
        } catch {
            failures++;
            return null;
        }
    });
    if (failures > slugs.length / 2) throw new Error(`cxtv: ${failures}/${slugs.length} channel pages failed`);

    const channels = parsed.filter((c): c is ScrapedChannel => c !== null);
    if (!channels.length) throw new Error("cxtv: no channel page had a direct stream URL");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "CXtv") };
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

export const cxtvScraper: Scraper = {
    id: SCRAPER_ID,
    name: "CXtv",
    version: "1.2.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/cxtv.mts` -- prints a channel count and the first
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
