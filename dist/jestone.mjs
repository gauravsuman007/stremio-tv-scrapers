/**
 * jest.one TV / World News 24 -- a ~20-channel international news wall.
 *
 * `tv.jest.one` and `worldnews24.tv` are the same site under two domains,
 * reading the byte-identical list from `tvdata.jest.one/` (also served as
 * `tvdata.worldnews24.tv/`): `[{ id, name, country, src, websiteUrl,
 * thumbnailUrl }]`. `src` is either a direct `.m3u8` from the
 * broadcaster's own CDN (Al Jazeera, DW, NHK World...) or a YouTube watch
 * URL; only the former are usable here, and a few entries inline their
 * playlist as a `data:` URI, which is skipped as well. Every direct URL
 * played with no headers at all when checked (2026-09-30).
 *
 * Small, and most of these channels are in iptv-org too -- an overlapping
 * channel merges centrally into the existing card as an extra mirror.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
const SCRAPER_ID = "jestone";
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
const LISTS = ["https://tvdata.jest.one/", "https://tvdata.worldnews24.tv/"];
/** The site's own free-text `country` -> ISO code. Regions ("Europe",
 *  "Africa", "Latin America") get no code. */
const COUNTRIES = {
    Australia: "AU",
    China: "CN",
    France: "FR",
    Germany: "DE",
    India: "IN",
    Israel: "IL",
    Japan: "JP",
    Qatar: "QA",
    Russia: "RU",
    Singapore: "SG",
    Turkey: "TR",
    "U.K.": "GB",
    "U.S.": "US"
};
function flagEmoji(code) {
    if (!/^[A-Z]{2}$/.test(code))
        return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
async function fetchList() {
    const errors = [];
    for (const url of LISTS) {
        try {
            const response = await withTimeout((signal) => fetch(url, { signal }));
            if (!response.ok)
                throw new Error(`${url} -> ${response.status}`);
            return (await response.json());
        }
        catch (cause) {
            errors.push(String(cause));
        }
    }
    throw new Error(`jestone: every list failed -- ${errors.join("; ")}`);
}
async function build() {
    const channels = [];
    for (const entry of await fetchList()) {
        const src = entry.src || "";
        if (!entry.id || !entry.name || !/^https?:\/\//.test(src) || /youtube\.com|youtu\.be/.test(src))
            continue;
        const country = COUNTRIES[entry.country || ""] || "";
        channels.push({
            id: idFor(entry.id),
            name: entry.name.trim(),
            country,
            countryName: country ? entry.country || "" : "",
            countryFlag: flagEmoji(country),
            categories: ["news"],
            languages: [],
            logo: "",
            website: entry.websiteUrl || "",
            network: "",
            streams: [{ url: src, quality: "", labels: [], referrer: "", userAgent: "" }]
        });
    }
    if (!channels.length)
        throw new Error("jestone: no direct streams in the list");
    return { channels };
}
export const jestoneScraper = {
    id: SCRAPER_ID,
    name: "jest.one TV / World News 24",
    version: "1.0.0",
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/jestone.mts` -- prints a channel count and the first
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
