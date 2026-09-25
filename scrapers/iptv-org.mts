/**
 * iptv-org's own curated, deduplicated JSON -- a second worked example
 * alongside ntvst.mts, this time for a source that already publishes
 * clean, well-typed data across several small endpoints rather than one
 * that has to be reverse-engineered. Ported from stremio-tv's own
 * built-in `src/scrapers/iptv-org.ts`, standalone (see
 * docs/scraper-template.ts's contract -- this is the same shape, filled
 * in, with no imports back into that repository).
 *
 * WHY THIS FILE CAN NEVER ACTUALLY REPLACE stremio-tv's BUILT-IN COPY:
 * stremio-tv ships iptv-org as a BUILT-IN scraper (`src/scrapers/iptv-org.ts`
 * in `BUILTIN`), precisely because it is the one source that deployment
 * cannot do without -- see that repo's AGENTS.md, "A source is a plugin".
 * Both "Import from GitHub" and a manual drop-in refuse to let anything
 * with an id already claimed by a built-in scraper through, on purpose
 * (see stremio-tv's `github-import.ts`), so importing this file changes
 * nothing there: it is kept here as a second reference implementation, not
 * a source anyone is meant to actually pull in. If you want a similarly
 * structured scraper for a DIFFERENT source, copy this file and its id
 * rather than trying to import it as-is.
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

interface ScrapedCatalogue {
    channels: ScrapedChannel[];
    rails?: { id: string; heading: string; channelIds: string[] }[];
}

interface Scraper {
    id: string;
    name: string;
    version?: string;
    build(): Promise<ScrapedCatalogue>;
}

const API = "https://iptv-org.github.io/api";
//: stremio-tv's real deployment keeps this id-prefix, `iptv:`, as a
//: pre-plugin-system legacy exception granted only to ITS OWN built-in
//: copy of this scraper -- carried over here for fidelity to the source
//: this was ported from, not because it means anything standalone.
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

    return { channels: out };
}

export const iptvOrgScraper: Scraper = {
    id: "iptv-org",
    name: "iptv-org",
    version: "1.0.0",
    build
};

// -------------------------------------------------------------------------
// Manual test: `npx tsx scrapers/iptv-org.mts`
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
            console.log(`${catalogue.channels.length} channels`);
            console.log(catalogue.channels[0] || "(none)");
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
