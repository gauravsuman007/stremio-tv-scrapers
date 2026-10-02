/**
 * iptv-org's own curated, deduplicated JSON -- a real source, and the DEFAULT
 * scraper of the live-tv app (github.com/gauravsuman007/live-tv), which
 * fetches `dist/iptv-org.mjs` from this repository the first time it starts
 * on an empty data volume and then keeps it current through its ordinary
 * "Check for updates" on Settings > Live TV > Sources (a real `version`
 * increase here is what replaces it). It is also a worked example, beside
 * ntvst.mts, for a source that already publishes clean JSON across a handful
 * of small endpoints rather than one that has to be reverse-engineered.
 *
 * Its `iptv:` id prefix and the id `iptv-org` are never renamed: channel ids,
 * the nightly checks and the cached logos are all keyed under them. If you
 * want a similar scraper for a DIFFERENT source, copy this file and give it
 * a different id -- two scrapers sharing an id is refused everywhere a
 * scraper is loaded, first one loaded wins.
 */

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
    filter?: {
        countries?: string[];
        categories?: string[];
        genres?: string[];
        languages?: string[];
        market?: "home-first" | "first";
    };
}

interface ScrapedPage {
    id: string;
    title: string;
    rails: { id: string; rows?: number }[];
}

interface ScrapedCatalogue {
    channels: ScrapedChannel[];
    rails?: ScrapedRail[];
    pages?: ScrapedPage[];
}

interface Scraper {
    id: string;
    name: string;
    version?: string;
    build(): Promise<ScrapedCatalogue>;
}

const API = "https://iptv-org.github.io/api";
//: stremio-tv's merge step keeps this exact id-prefix, `iptv:`, as a
//: pre-plugin-system legacy exception granted specifically to whichever
//: scraper has the id "iptv-org" (by id, not by how it was loaded -- see
//: that repo's AGENTS.md), so a deployment's existing favourites and
//: watch-progress rows keep matching once this scraper is imported. NEVER
//: change this scraper's own id away from "iptv-org" below, or this
//: exception stops applying and every existing id here becomes unrecognised.
const PREFIX = "iptv:";
const FETCH_TIMEOUT_MS = 30_000;

async function grab<T>(name: string): Promise<T[]> {
    const response = await fetch(`${API}/${name}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (!response.ok) throw new Error(`${name}.json -> ${response.status}`);

    return (await response.json()) as T[];
}

interface RawChannel {
    id: string;
    name: string;
    country: string;
    categories: string[];
    is_nsfw: boolean;
    closed: string | null;
    replaced_by: string | null;
    website: string | null;
    network: string | null;
}

interface RawStream {
    channel: string | null;
    url: string;
    quality: string | null;
    labels?: string[];
    user_agent: string | null;
    referrer: string | null;
}

interface RawFeed {
    channel: string;
    is_main: boolean;
    languages: string[];
}

interface RawLogo {
    channel: string;
    url: string;
    width: number;
    height: number;
    format: string;
}

interface RawCountry {
    name: string;
    code: string;
    flag: string;
}

interface RawBlocked {
    channel: string;
}

async function build(): Promise<ScrapedCatalogue> {
    /*
        All six at once, and all six have to arrive. A half-built catalogue
        -- channels with no streams, or streams with no names -- is worse
        than this scraper saying it could not reach the list, because the
        merge step downstream cannot tell "empty on purpose" from "broken".
    */
    const [rawChannels, rawStreams, rawFeeds, rawLogos, rawCountries, blocked] = await Promise.all([
        grab<RawChannel>("channels"),
        grab<RawStream>("streams"),
        grab<RawFeed>("feeds"),
        grab<RawLogo>("logos"),
        grab<RawCountry>("countries"),
        grab<RawBlocked>("blocklist")
    ]);

    const banned = new Set(blocked.map((entry) => entry.channel));

    const mirrors = new Map<string, ScrapedStream[]>();

    for (const raw of rawStreams) {
        // A stream with no channel is one nobody has matched to a name yet
        // -- no country, no category, no logo -- so it cannot be placed on
        // any rail and is dropped rather than shown as an untitled card.
        if (!raw.channel || banned.has(raw.channel)) continue;

        const list = mirrors.get(raw.channel) || [];

        list.push({
            url: raw.url,
            quality: raw.quality || "",
            labels: raw.labels || [],
            referrer: raw.referrer || "",
            userAgent: raw.user_agent || ""
        });
        mirrors.set(raw.channel, list);
    }

    const languages = new Map<string, string[]>();

    for (const feed of rawFeeds) {
        if (feed.is_main && feed.languages?.length) languages.set(feed.channel, feed.languages);
    }

    /*
        THE BIGGEST RASTER LOGO, and a vector one only if there is nothing
        else -- an SVG logo breaks a proxy that can re-type raster formats
        but cannot sniff SVG (see the template's own note on this), which
        is iptv-org's own quirk (several American networks publish nothing
        else), not a rule every scraper needs to know.
    */
    const logos = new Map<string, RawLogo>();

    const vector = (logo: RawLogo): boolean => /svg/i.test(logo.format || "");

    for (const logo of rawLogos) {
        const best = logos.get(logo.channel);

        if (!best) {
            logos.set(logo.channel, logo);
            continue;
        }

        if (vector(best) && !vector(logo)) {
            logos.set(logo.channel, logo);
            continue;
        }

        if (vector(logo) && !vector(best)) continue;

        if ((logo.width || 0) > (best.width || 0)) logos.set(logo.channel, logo);
    }

    const named = new Map(rawCountries.map((entry) => [entry.code, entry]));
    const out: ScrapedChannel[] = [];

    for (const raw of rawChannels) {
        const streams = mirrors.get(raw.id);

        // Four ways a channel is not offered: nothing carries it, it has
        // shut down, it is adult, or it is on the blocklist (nsfw and DMCA
        // complaints). A closed channel with a replacement is not silently
        // swapped for the replacement -- the replacement is in this list
        // on its own account.
        if (!streams || !streams.length) continue;
        if (raw.closed || raw.is_nsfw || banned.has(raw.id)) continue;
        if (raw.categories.includes("xxx")) continue;

        const logo = logos.get(raw.id);
        const country = raw.country || "";

        out.push({
            id: PREFIX + raw.id,
            name: raw.name,
            country,
            countryName: named.get(country)?.name || country,
            countryFlag: named.get(country)?.flag || "",
            categories: raw.categories || [],
            languages: languages.get(raw.id) || [],
            logo: logo?.url || "",
            website: raw.website || "",
            network: raw.network || "",
            streams
        });
    }

    return { channels: out, ...layoutFor(out, named) };
}

/*
    THE RAILS, AND THE PAGES THAT START WITH THEM.

    Every rail the Live TV app can show comes from here or from another
    source; the app itself names no genre, country or language. They are
    DESCRIBED (`filter`) rather than listed, so the app fills each one from
    the finished index -- ranked by what last night's check proved, across
    every source at once, and for the household that is looking
    (`market`) -- instead of this scraper freezing a list of ids that goes
    stale the day a channel stops playing.

    Which rails exist is read from the data: a country appears when it has
    channels, a language when enough of them speak it. A rail that would
    hold two cards reads as a broken rail, so each kind has a floor.
*/

/** The host's own genre ids (taxonomy.ts there), with how each is titled. */
const GENRES: [string, string][] = [
    ["news", "News"],
    ["entertainment", "Entertainment"],
    ["movies", "Movies"],
    ["sports", "Sports"],
    ["kids", "Kids"],
    ["music", "Music"],
    ["documentary", "Documentary"],
    ["lifestyle", "Lifestyle"],
    ["business", "Business"],
    ["devotional", "Devotional"],
    ["general", "General"]
];

/** iptv-org files cartoons under "animation" and family channels under
 *  "family"; a Kids rail that reads only "kids" misses most of what a
 *  child would watch. */
const KIDS = ["kids", "animation", "family"];

/** Below these a rail is not worth a heading. */
const MIN_COUNTRY = 4;
const MIN_LANGUAGE = 6;
const MIN_KIDS = 4;

/** The languages the starting For you page has a rail for, in this order. */
const FOR_YOU = ["hin", "mal", "tam", "tel"];

/** Which part of the world a country is in, for the "Countries" groups. */
const CONTINENTS: [string, string, string][] = [
    ["Asia", "asia", "AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE AE"],
    ["Europe", "europe", "AD AL AT BA BE BG BY CH CZ DE DK EE ES FI FO FR GB UK GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK"],
    ["Africa", "africa", "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW RE"],
    ["North America", "north-america", "US CA MX GL BM"],
    ["Latin America & Caribbean", "latin-america", "AG AI AR AW BB BO BQ BR BS BZ CL CO CR CU CW DM DO EC GD GT GY HN HT JM KN KY LC NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI MQ GP GF"],
    ["Oceania", "oceania", "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS"]
];

function continentName(code: string): string {
    return CONTINENTS.find(([, , codes]) => codes.split(" ").includes(code.toUpperCase()))?.[0] || "Elsewhere";
}

function languageName(code: string): string {
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);

        return name && name !== code ? name : code.toUpperCase();
    } catch {
        return code.toUpperCase();
    }
}

function layoutFor(
    channels: ScrapedChannel[],
    countries: Map<string, RawCountry>
): { rails: ScrapedRail[]; pages: ScrapedPage[] } {
    const perCountry = new Map<string, number>();
    const perLanguage = new Map<string, number>();
    const kidsPerLanguage = new Map<string, number>();

    for (const channel of channels) {
        if (channel.country) perCountry.set(channel.country, (perCountry.get(channel.country) || 0) + 1);

        const kids = channel.categories.some((category) => KIDS.includes(category));

        for (const code of channel.languages) {
            perLanguage.set(code, (perLanguage.get(code) || 0) + 1);
            if (kids) kidsPerLanguage.set(code, (kidsPerLanguage.get(code) || 0) + 1);
        }
    }

    const rails: ScrapedRail[] = [];

    for (const [id, heading] of GENRES) {
        rails.push({
            id: `genre-${id}`,
            heading,
            by: "Your countries first",
            group: "Genres",
            channelIds: [],
            filter: { genres: [id], market: "home-first" }
        });
    }

    const byName = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);

    for (const [code, count] of [...perCountry.entries()].sort(byName)) {
        const name = countries.get(code)?.name;

        if (count < MIN_COUNTRY || !name || !/^[A-Za-z]{2,3}$/.test(code)) continue;

        rails.push({
            id: `country-${code.toLowerCase()}`,
            heading: `Top channels in ${name}`,
            by: "Most widely carried",
            group: `Countries/${continentName(code)}`,
            channelIds: [],
            filter: { countries: [code] }
        });
    }

    for (const [code, count] of [...perLanguage.entries()].sort(byName)) {
        if (count < MIN_LANGUAGE || !/^[a-z]{2,3}$/.test(code)) continue;

        const name = languageName(code);

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

    for (const [code, count] of [...kidsPerLanguage.entries()].sort(byName)) {
        if (count < MIN_KIDS || !/^[a-z]{2,3}$/.test(code)) continue;

        rails.push({
            id: `kids-${code}`,
            heading: `Kids in ${languageName(code)}`,
            by: "Your countries first",
            group: "Kids/By language",
            channelIds: [],
            filter: { categories: KIDS, languages: [code], market: "home-first" }
        });
    }

    const have = new Set(rails.map((rail) => rail.id));
    const pick = (ids: string[], rows: number) => ids.filter((id) => have.has(id)).map((id) => ({ id, rows }));

    /*
        A genre page is one wall of that genre: rows 0, "as many lines as
        it takes", which is what these pages have always been. The For you
        page is rails of one line, the way a rail has always scrolled.
    */
    const pages: ScrapedPage[] = [
        { id: "foryou", title: "For you", rails: pick(FOR_YOU.map((code) => `language-${code}-home`), 1) },
        { id: "documentary", title: "Documentary", rails: pick(["genre-documentary"], 0) },
        { id: "sports", title: "Sports", rails: pick(["genre-sports"], 0) },
        { id: "kids", title: "Kids", rails: pick(["genre-kids"], 0) },
        { id: "news", title: "News", rails: pick(["genre-news"], 0) }
    ];

    return { rails, pages };
}

export const iptvOrgScraper: Scraper = {
    id: "iptv-org",
    name: "iptv-org",
    version: "1.2.0",
    build
};

// -------------------------------------------------------------------------
// Manual test: `npx tsx scrapers/iptv-org.mts`
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
            console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails, ${(catalogue.pages || []).length} pages`);
            console.log(catalogue.channels[0] || "(none)");
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
