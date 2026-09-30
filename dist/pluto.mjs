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
const SCRAPER_ID = "pluto";
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
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
async function getJson(url, token) {
    const response = await withTimeout((signal) => fetch(url, {
        signal,
        headers: { "User-Agent": UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    }));
    if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
    return (await response.json());
}
function flagEmoji(code) {
    if (!/^[A-Z]{2}$/.test(code))
        return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
function logoFor(channel) {
    const images = channel.images || [];
    const pick = images.find((i) => i.type === "colorLogoPNG") || images.find((i) => i.type === "logo");
    return pick?.url || "";
}
async function build() {
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
    const boot = await getJson(`https://boot.pluto.tv/v4/start?${bootQuery}`);
    const token = boot.sessionToken;
    const stitcher = boot.servers?.stitcher;
    const channelsHost = boot.servers?.channels || "https://service-channels.clusters.pluto.tv";
    if (!token || !stitcher || !boot.stitcherParams)
        throw new Error("pluto: boot response missing token/stitcher");
    const [channelResponse, categoryResponse] = await Promise.all([
        getJson(`${channelsHost}/v2/guide/channels?channelIds=&offset=0&limit=5000&lang=en`, token),
        getJson(`${channelsHost}/v2/guide/categories?lang=en&offset=0&limit=500`, token).catch(() => ({ data: [] }))
    ]);
    const categoriesById = new Map();
    for (const category of categoryResponse.data || []) {
        if (!category.name)
            continue;
        for (const id of category.channelIDs || []) {
            const list = categoriesById.get(id) || [];
            list.push(category.name.toLowerCase());
            categoriesById.set(id, list);
        }
    }
    const region = (boot.session?.activeRegion || "").toUpperCase();
    const channels = [];
    for (const entry of channelResponse.data || []) {
        const path = entry.stitched?.path;
        if (!entry.id || !entry.name || !path)
            continue;
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
    if (!channels.length)
        throw new Error("pluto: channel list came back empty");
    return { channels };
}
export const plutoScraper = {
    id: SCRAPER_ID,
    name: "Pluto TV",
    version: "1.0.0",
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
