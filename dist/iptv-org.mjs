/**
 * iptv-org's own curated, deduplicated JSON -- a real source, and also a
 * worked example alongside ntvst.mts for a source that already publishes
 * clean, well-typed data across several small endpoints rather than one
 * that has to be reverse-engineered.
 *
 * THIS IS THE ACTUAL iptv-org SOURCE, IMPORTABLE AS-IS. stremio-tv ships
 * with nothing built in (see that repo's AGENTS.md, "A source is a
 * plugin") -- iptv-org and ntv.st are both ordinary sources pulled in from
 * THIS repository via Settings > Live TV > Sources > "Import from GitHub",
 * same as anything else here. If you want a similarly structured scraper
 * for a DIFFERENT source, copy this file and give it a different id --
 * two scrapers sharing an id is refused by both the GitHub importer and a
 * manual drop-in, first one loaded wins.
 */
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
async function grab(name) {
    const response = await fetch(`${API}/${name}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok)
        throw new Error(`${name}.json -> ${response.status}`);
    return (await response.json());
}
async function build() {
    /*
        All six at once, and all six have to arrive. A half-built catalogue
        -- channels with no streams, or streams with no names -- is worse
        than this scraper saying it could not reach the list, because the
        merge step downstream cannot tell "empty on purpose" from "broken".
    */
    const [rawChannels, rawStreams, rawFeeds, rawLogos, rawCountries, blocked] = await Promise.all([
        grab("channels"),
        grab("streams"),
        grab("feeds"),
        grab("logos"),
        grab("countries"),
        grab("blocklist")
    ]);
    const banned = new Set(blocked.map((entry) => entry.channel));
    const mirrors = new Map();
    for (const raw of rawStreams) {
        // A stream with no channel is one nobody has matched to a name yet
        // -- no country, no category, no logo -- so it cannot be placed on
        // any rail and is dropped rather than shown as an untitled card.
        if (!raw.channel || banned.has(raw.channel))
            continue;
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
    const languages = new Map();
    for (const feed of rawFeeds) {
        if (feed.is_main && feed.languages?.length)
            languages.set(feed.channel, feed.languages);
    }
    /*
        THE BIGGEST RASTER LOGO, and a vector one only if there is nothing
        else -- an SVG logo breaks a proxy that can re-type raster formats
        but cannot sniff SVG (see the template's own note on this), which
        is iptv-org's own quirk (several American networks publish nothing
        else), not a rule every scraper needs to know.
    */
    const logos = new Map();
    const vector = (logo) => /svg/i.test(logo.format || "");
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
        if (vector(logo) && !vector(best))
            continue;
        if ((logo.width || 0) > (best.width || 0))
            logos.set(logo.channel, logo);
    }
    const named = new Map(rawCountries.map((entry) => [entry.code, entry]));
    const out = [];
    for (const raw of rawChannels) {
        const streams = mirrors.get(raw.id);
        // Four ways a channel is not offered: nothing carries it, it has
        // shut down, it is adult, or it is on the blocklist (nsfw and DMCA
        // complaints). A closed channel with a replacement is not silently
        // swapped for the replacement -- the replacement is in this list
        // on its own account.
        if (!streams || !streams.length)
            continue;
        if (raw.closed || raw.is_nsfw || banned.has(raw.id))
            continue;
        if (raw.categories.includes("xxx"))
            continue;
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
export const iptvOrgScraper = {
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
