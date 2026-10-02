/**
 * Famelack -- ~6.7k live-TV channels across ~170 countries, published as a
 * plain public dataset on GitHub (`famelack/famelack-data`) that the
 * famelack.com player itself reads. No API, no gate: every file is static
 * JSON on raw.githubusercontent.com.
 *
 *   - `tv/raw/countries_metadata.json` -- `{ <ISO>: { country,
 *     hasChannels, channelCount } }`, used to enumerate countries.
 *   - `tv/raw/countries/<iso lowercase>.json` -- that country's channels:
 *     `{ nanoid, name, sources: { streams?: string[], youtube?: string[] },
 *     languages, country, isGeoBlocked }`.
 *   - `tv/raw/categories/<category>.json` -- the same records, grouped by
 *     category; read only to tag each channel with its categories. The
 *     category names aren't listed anywhere in the dataset, so the
 *     iptv-org-style names below are tried and any 404 is ignored.
 *
 * Much of the dataset overlaps iptv-org (it credits iptv-org as a
 * source); an overlapping channel merges centrally into the existing card
 * as an extra mirror rather than duplicating it. `youtube` sources are
 * YouTube embed pages, not streams, and are skipped -- a channel with
 * only YouTube sources is dropped.
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
    filter?: { countries?: string[]; categories?: string[]; genres?: string[]; languages?: string[]; market?: "home-first" | "first" };
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

const SCRAPER_ID = "famelack";

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

const DATA = "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/raw";

const CATEGORY_GUESSES = [
    "animation", "auto", "business", "classic", "comedy", "cooking", "culture", "documentary",
    "education", "entertainment", "family", "general", "kids", "legislative", "lifestyle",
    "movies", "music", "news", "outdoor", "relax", "religious", "science", "series", "shop",
    "sports", "travel", "weather"
];

interface FamelackChannel {
    nanoid?: string;
    name?: string;
    sources?: { streams?: string[]; youtube?: string[] };
    languages?: string[];
    country?: string;
    isGeoBlocked?: boolean;
}

async function getJson<T>(url: string): Promise<T | null> {
    const response = await withTimeout((signal) => fetch(url, { signal }));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return (await response.json()) as T;
}

function flagEmoji(code: string): string {
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

async function build(): Promise<ScrapedCatalogue> {
    const meta = await getJson<Record<string, { country?: string; hasChannels?: boolean }>>(
        `${DATA}/countries_metadata.json`
    );
    if (!meta) throw new Error("famelack: countries_metadata.json missing");
    const countries = Object.entries(meta).filter(([, v]) => v.hasChannels);

    const categoriesById = new Map<string, string[]>();
    await mapWithConcurrency(CATEGORY_GUESSES, 8, async (category) => {
        const list = await getJson<FamelackChannel[]>(`${DATA}/categories/${category}.json`).catch(() => null);
        for (const entry of list || []) {
            if (!entry.nanoid) continue;
            const existing = categoriesById.get(entry.nanoid) || [];
            existing.push(category);
            categoriesById.set(entry.nanoid, existing);
        }
    });

    let failures = 0;
    const perCountry = await mapWithConcurrency(countries, 8, async ([code, info]) => {
        try {
            const list = await getJson<FamelackChannel[]>(`${DATA}/countries/${code.toLowerCase()}.json`);
            return { code: code.toUpperCase(), name: info.country || "", list: list || [] };
        } catch (cause) {
            failures++;
            console.error(`famelack: ${code} failed`, cause);
            return { code, name: "", list: [] as FamelackChannel[] };
        }
    });
    if (failures === countries.length) throw new Error("famelack: every country file failed");

    const seen = new Set<string>();
    const channels: ScrapedChannel[] = [];

    for (const { code, name: countryName, list } of perCountry) {
        for (const entry of list) {
            if (!entry.nanoid || !entry.name || seen.has(entry.nanoid)) continue;
            const urls = (entry.sources?.streams || []).filter((u) => /^https?:\/\//.test(u));
            if (!urls.length) continue;
            seen.add(entry.nanoid);

            const labels = entry.isGeoBlocked ? ["Geo-blocked"] : [];
            channels.push({
                id: idFor(entry.nanoid),
                name: entry.name.trim(),
                country: code,
                countryName,
                countryFlag: flagEmoji(code),
                categories: categoriesById.get(entry.nanoid) || [],
                languages: entry.languages || [],
                logo: "",
                website: "",
                network: "",
                streams: urls.map((url) => ({ url, quality: "", labels, referrer: "", userAgent: "" }))
            });
        }
    }

    if (!channels.length) throw new Error("famelack: no channels found");
    return { channels, rails: categoryRails(channels, "Famelack") };
}

// -------------------------------------------------------------------------
// Rails from this source's own category words.
//
// The host already folds the common words (news, sports, kids ...) into its
// genre rails; what is left -- "Sitcoms + Comedy", "Animals & Nature" -- is
// this source's own vocabulary, so it is declared as rails of its own,
// grouped under "Categories / <source>" in the lists of every rail.
// -------------------------------------------------------------------------

/** Words the host's genre rails already carry, so a rail of their own would repeat one. */
const GENRE_WORDS = new Set([
    "news", "sports", "sport", "movies", "movie", "films", "film", "kids", "children", "animation", "music",
    "documentary", "lifestyle", "business", "entertainment", "general", "religious", "education", "culture",
    "legislative", "series", "family", "weather", "other"
]);

/** Never offered as a rail: shopping and adult shelves. */
const UNLISTED = /\b(shop\w*|xxx|adult|erotic\w*|sinnlich\w*|telesales|18\+)\b/i;

function categoryRails(channels: ScrapedChannel[], sourceName: string, min = 5, cap = 30): ScrapedRail[] {
    const counts = new Map<string, number>();

    for (const channel of channels) {
        for (const word of new Set(channel.categories)) counts.set(word, (counts.get(word) || 0) + 1);
    }

    const taken = new Set<string>();
    const rails: ScrapedRail[] = [];
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    for (const [word, count] of ranked) {
        const slug = `cat-${word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");

        if (count < min || word.length > 40 || GENRE_WORDS.has(word) || UNLISTED.test(word) || slug === "cat" || taken.has(slug)) continue;

        taken.add(slug);
        rails.push({
            id: slug,
            heading: word.replace(/(^|[\s(+&/-])(\p{L})/gu, (_all, lead: string, first: string) => lead + first.toUpperCase()).replace(/\bTv\b/g, "TV"),
            by: `From ${sourceName}`,
            channelIds: [],
            filter: { categories: [word] },
            group: `Categories/${sourceName.replace(/\//g, " ")}`
        });

        if (rails.length >= cap) break;
    }

    return rails;
}

export const famelackScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Famelack",
    version: "1.1.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/famelack.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
            console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
            console.log(`${catalogue.channels.filter((c) => c.categories.length).length} with categories`);
            console.log(catalogue.channels[0] || "(none)");
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
