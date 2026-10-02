/**
 * Pluto TV -- free, ad-supported, fully legal linear TV (~400 channels in
 * the US, a different line-up per region).
 *
 * Three unauthenticated steps, all on Pluto's own public web-app API:
 *
 *   1. `GET boot.pluto.tv/v4/start?...` with a fresh random `clientID`
 *      answers a `sessionToken` (a 24-hour JWT), the `stitcher` host to
 *      use, `stitcherParams` (a query string the stitcher expects), and the
 *      region Pluto placed the caller in (`session.activeRegion`).
 *   2. `GET service-channels.../v2/guide/channels` and `.../categories`
 *      with that JWT as a Bearer token list every channel (name, logo,
 *      `stitched.path`) and the category each belongs to.
 *   3. Each stream URL is `<stitcher>/v2<stitched.path>?<stitcherParams>
 *      &jwt=<sessionToken>&masterJWTPassthrough=true`.
 *
 * WHY THE JWT IS BAKED INTO EVERY URL: the older JWT-less host
 * (`service-stitcher.clusters.pluto.tv/stitch/hls/...`, still used by
 * many IPTV lists) still answers 200 with a valid playlist -- but every
 * segment in it is Pluto's generic "takedown slate", not the channel.
 * Only the JWT-carrying stitcher serves real programming. The token lasts
 * 24 hours and the host rebuilds every 12, so a URL is always replaced
 * before it expires. The JWT also records the caller's IP/region at boot
 * time; a player on a very different network from the stremio-tv server
 * may therefore see a different region's slate or a geo-block.
 *
 * The line-up is whatever region the SERVER running `build()` sits in --
 * Pluto has no region parameter an anonymous client can override.
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

const SCRAPER_ID = "pluto";

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

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

interface Boot {
    servers?: { channels?: string; stitcher?: string };
    session?: { activeRegion?: string };
    stitcherParams?: string;
    sessionToken?: string;
}

interface PlutoChannel {
    id: string;
    slug?: string;
    name?: string;
    stitched?: { path?: string };
    images?: Array<{ type?: string; url?: string }>;
}

interface PlutoCategory {
    name?: string;
    channelIDs?: string[];
}

async function getJson<T>(url: string, token?: string): Promise<T> {
    const response = await withTimeout((signal) =>
        fetch(url, {
            signal,
            headers: { "User-Agent": UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
        })
    );
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return (await response.json()) as T;
}

function flagEmoji(code: string): string {
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function logoFor(channel: PlutoChannel): string {
    const images = channel.images || [];
    const pick = images.find((i) => i.type === "colorLogoPNG") || images.find((i) => i.type === "logo");
    return pick?.url || "";
}

async function build(): Promise<ScrapedCatalogue> {
    const clientId = crypto.randomUUID();
    const bootQuery = new URLSearchParams({
        appName: "web",
        appVersion: "9.0.0",
        deviceVersion: "128.0.0",
        deviceModel: "web",
        deviceMake: "chrome",
        deviceType: "web",
        clientID: clientId,
        clientModelNumber: "1.0.0",
        serverSideAds: "false"
    });
    const boot = await getJson<Boot>(`https://boot.pluto.tv/v4/start?${bootQuery}`);
    const token = boot.sessionToken;
    const stitcher = boot.servers?.stitcher;
    const channelsHost = boot.servers?.channels || "https://service-channels.clusters.pluto.tv";
    if (!token || !stitcher || !boot.stitcherParams) throw new Error("pluto: boot response missing token/stitcher");

    const [channelResponse, categoryResponse] = await Promise.all([
        getJson<{ data?: PlutoChannel[] }>(`${channelsHost}/v2/guide/channels?channelIds=&offset=0&limit=5000&lang=en`, token),
        getJson<{ data?: PlutoCategory[] }>(`${channelsHost}/v2/guide/categories?lang=en&offset=0&limit=500`, token).catch(
            () => ({ data: [] as PlutoCategory[] })
        )
    ]);

    const categoriesById = new Map<string, string[]>();
    for (const category of categoryResponse.data || []) {
        if (!category.name) continue;
        for (const id of category.channelIDs || []) {
            const list = categoriesById.get(id) || [];
            list.push(category.name.toLowerCase());
            categoriesById.set(id, list);
        }
    }

    const region = (boot.session?.activeRegion || "").toUpperCase();
    const channels: ScrapedChannel[] = [];

    for (const entry of channelResponse.data || []) {
        const path = entry.stitched?.path;
        if (!entry.id || !entry.name || !path) continue;

        channels.push({
            id: idFor(entry.slug || entry.id),
            name: entry.name.trim(),
            country: region,
            countryName: "",
            countryFlag: flagEmoji(region),
            categories: categoriesById.get(entry.id) || [],
            languages: [],
            logo: logoFor(entry),
            website: entry.slug ? `https://pluto.tv/live-tv/${entry.slug}` : "https://pluto.tv/",
            network: "Pluto TV",
            streams: [
                {
                    url: `${stitcher}/v2${path}?${boot.stitcherParams}&jwt=${token}&masterJWTPassthrough=true`,
                    quality: "",
                    labels: [],
                    referrer: "",
                    userAgent: ""
                }
            ]
        });
    }

    if (!channels.length) throw new Error("pluto: channel list came back empty");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "Pluto TV") };
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

export const plutoScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Pluto TV",
    version: "1.2.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/pluto.mts` -- prints a channel count and the first
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
