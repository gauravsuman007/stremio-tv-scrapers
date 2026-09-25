/**
 * TEMPLATE: a live-TV scraper for stremio-tv.
 * ============================================
 *
 * This file is self-contained on purpose -- it imports nothing from the
 * repository it is meant to join. Develop it anywhere, test it with plain
 * `node` or `tsx`, and hand the finished file back.
 *
 * COMPILE IT YOURSELF -- THIS CONTAINER RUNS NO TYPESCRIPT
 * -----------------------------------------------------------
 * Before handing the file back, compile it to plain JavaScript with the
 * SAME STRICTNESS this repository builds under, so it needs no further
 * editing on the other end. Name the SOURCE file `<your-id>.mts`, not
 * `.ts` -- that one letter is what makes `tsc` emit `.mjs` on its own,
 * which matters (see below):
 *
 *     tsc --strict --noUncheckedIndexedAccess --target ES2022 \
 *         --module ES2022 --moduleResolution bundler \
 *         <your-id>.mts
 *
 * `--noUncheckedIndexedAccess` is the one most templates miss: it means
 * `array[i]` is typed `T | undefined`, not `T`, everywhere -- including a
 * regex match's capture groups (`match[1]`) and every `for (let i = 0; ...)`
 * loop. Either narrow before use (`if (!entry) continue;`) or assert where
 * a bound already guarantees it (`array[i]!`) -- don't hand back a file
 * that only compiles with these flags loosened, since loosening them for
 * one file loosens them for the whole build.
 *
 * WHY `.mjs`, NEVER PLAIN `.js`: Node decides whether a `.js` file is a
 * module or CommonJS from the nearest `package.json`'s `"type"` field --
 * and the directory a dropped-in scraper lands in (a bind-mounted data
 * volume) has no `package.json` at all, so a bare `.js` defaults to
 * CommonJS and fails to parse the `import`/`export` syntax `tsc` emits.
 * `.mjs` has no such ambiguity; it is always a module, everywhere. Compile
 * from a `.mts` SOURCE rather than renaming the compiled output by hand --
 * `tsc` then also type-checks against Node's ESM resolution rules, which
 * `.ts` does not.
 *
 * Three ways to hand the finished, compiled scraper back -- pick whichever
 * fits how you're delivering it:
 *
 *   * IMPORT FROM GITHUB, NO COPYING AT ALL -- if this scraper lives in a
 *     repository with a `dist/` directory holding its compiled `.mjs`
 *     output COMMITTED (not gitignored -- see that repository's own
 *     AGENTS.md if it has one), Settings > Live TV > Sources > "Import
 *     from GitHub" reads it directly: enter the repo, an optional branch
 *     and, for a private repo, an access token, and it is fetched, checked
 *     and dropped in with no manual copying at all. Set `version` below so
 *     a later re-check only replaces this scraper when it is genuinely
 *     newer -- see that field's own comment.
 *   * DROP IT IN, NO REBUILD -- copy the compiled `<your-id>.mjs` into the
 *     `scrapers` directory on the deployment's mounted data volume, then
 *     reload it from Settings > Live TV > Sources > "Reload sources" (or
 *     just restart the container). It appears immediately, on by default,
 *     checked and ranked exactly like every other source -- no image
 *     rebuild, no redeploy, and no access to this repository needed at
 *     all. This is the route for a scraper built somewhere else and
 *     handed back as a finished file, with nowhere to import it from.
 *   * BUILT INTO THE IMAGE -- for someone with the repo open: save this
 *     file (the `.ts`, not the compiled output) as
 *     `src/scrapers/<your-id>.ts`, then in `src/scrapers.ts` add an import
 *     and one entry to the `BUILTIN` array:
 *
 *         import { myScraper } from "./scrapers/<your-id>.js";
 *         const BUILTIN: Scraper[] = [iptvOrgScraper, myScraper];
 *
 *     Needs a rebuild and a redeploy, worth it only for a source the
 *     deployment should never run without.
 *
 * WHAT YOUR SCRAPER OWES THE REST OF THE SYSTEM
 * -----------------------------------------------
 * Exactly one function, `build()`, that returns every channel your source
 * currently knows about, freshly fetched, and -- OPTIONALLY -- some named
 * groupings of your own channels to offer as rails. You do NOT need to:
 *
 *   - check whether a stream URL actually plays -- the nightly sweep does
 *     that for every source, uniformly;
 *   - rank or score anything, on a channel OR a rail -- ranking happens
 *     centrally, from fields every channel already carries (mirror count,
 *     category, whether it has a logo and so on); a rail you declare shows
 *     your channels best-first the same way any other rail does;
 *   - group your channels into rails at all -- most scrapers have no
 *     opinion here and leave `rails` out; the generic country/theme/kids
 *     rails are built centrally regardless, from every source at once;
 *   - worry about how often you are called -- `build()` is invoked at most
 *     once per index rebuild (every twelve hours, or on a manual refresh),
 *     never per page view.
 *
 * You DO need to:
 *
 *   - give every channel a globally unique id in YOUR OWN namespace (see
 *     `idFor` below) -- ids are never merged or reconciled across sources,
 *     a collision just means one of the two is silently dropped;
 *   - throw, rather than return an empty catalogue, when the fetch
 *     genuinely failed -- the caller keeps last night's channels on a
 *     thrown error, but an empty `channels` array is taken as "this source
 *     now has zero channels" and replaces them with nothing;
 *   - keep it reasonably fast and bounded -- there is no global timeout
 *     wrapped around `build()`, so set your own (see `withTimeout` below)
 *     rather than let one slow request hold up the whole rebuild.
 *
 * NEVER RETURN A STREAM URL YOU HAVE NOT AT LEAST FOUND IN YOUR SOURCE'S
 * OWN LISTING. This scraper is trusted to say what exists; it is not
 * trusted to guess.
 */

// -------------------------------------------------------------------------
// The shapes you build, copied verbatim from `src/scraper-types.ts` so this
// file needs nothing else. Keep them in sync if you pull a newer copy of
// this template later.
// -------------------------------------------------------------------------

interface ScrapedStream {
    url: string;
    /** Free text, e.g. "1080p". Not trusted, only shown. */
    quality: string;
    /** Short warnings such as "Geo-blocked" or "Not 24/7". */
    labels: string[];
    /** HTTP Referer this stream needs, or "". */
    referrer: string;
    /** User-Agent this stream needs, or "". */
    userAgent: string;
}

interface ScrapedChannel {
    /** Must start with `live:<your-scraper-id>:` -- see `idFor`. */
    id: string;
    name: string;
    /** ISO-ish country code as your source writes it, or "" if unknown. */
    country: string;
    /** The same country written out. "" falls back to the code. */
    countryName: string;
    /** That country's flag emoji, or "". */
    countryFlag: string;
    /** Free-text categories -- "news", "sports", "kids" and so on. Made-up
     *  categories are fine; unrecognised ones are simply worth nothing to
     *  the ranking rather than penalised. */
    categories: string[];
    /** ISO 639-3 codes for the channel's main language, if known. */
    languages: string[];
    /** A direct image URL. SVG is avoided if you have a choice -- the
     *  artwork proxy this surface uses can re-type raster formats but
     *  cannot sniff SVG, so an SVG logo renders as a broken image. */
    logo: string;
    website: string;
    network: string;
    /** At least one, or the channel is dropped centrally -- no need to
     *  filter empty-stream channels out yourself, but you may. */
    streams: ScrapedStream[];
}

interface ScrapedRail {
    /** A short slug, unique within THIS scraper only, `[a-z0-9-]` and 40
     *  characters or fewer -- e.g. "anime-simulcasts". The final id shown
     *  to a viewer is built centrally as `rail:<your-scraper-id>-<this>`,
     *  so two scrapers can both call theirs "sport" with no collision. */
    id: string;
    /** Shown as the rail's heading, same as any other rail. */
    heading: string;
    /** Ids of channels THIS SAME `build()` call also returned in
     *  `channels`. An id belonging to another scraper, or one this call
     *  did not itself return, is dropped rather than resolved -- a rail is
     *  not a way to reach into somebody else's catalogue. */
    channelIds: string[];
}

interface ScrapedCatalogue {
    channels: ScrapedChannel[];
    /** Leave out entirely if you have no opinion about grouping -- most
     *  scrapers do, and that is the normal case, not a missing feature. */
    rails?: ScrapedRail[];
}

/** A value one of this scraper's own config fields can hold. */
type ScraperConfigValue = string | number | boolean;

/**
 * One user-settable knob this scraper declares for itself -- an interval, a
 * pacing delay, a page size, anything the person running a deployment might
 * reasonably want to change without editing this file. Shown in Settings >
 * Live TV > Sources next to a gear icon beside this scraper's name,
 * pre-filled with its CURRENT value (whatever is stored, or `default` if
 * this deployment has never changed it).
 *
 * OPTIONAL -- a scraper with nothing worth exposing simply has no
 * `configSchema` at all, and gets no gear icon. This is the common case
 * unless your scraper also declares `tasks` (see below), where at least one
 * interval field is the whole point.
 */
interface ScraperConfigField {
    /** Stable, unique within THIS scraper's own schema. Never reuse a key
     *  for a field of a different meaning later -- see "Config values
     *  survive an update" below for why that matters. */
    key: string;
    /** Shown as the field's label in the settings form. */
    label: string;
    type: "number" | "string" | "boolean";
    /** Both this field's starting value on a fresh deployment AND the
     *  fallback used whenever a stored value no longer matches this field
     *  (wrong type, or the field is new since the value was last saved). */
    default: ScraperConfigValue;
    /** For a `"number"` field only. */
    min?: number;
    max?: number;
    /** A short explanation shown under the field in the settings form. */
    help?: string;
}

/** What a task's `run()` is handed. See `ScraperTask` below. */
interface ScraperTaskContext {
    /** This scraper's current config values, already reconciled against
     *  `configSchema` -- read directly, no lookup needed. */
    config: Record<string, ScraperConfigValue>;
    /**
     * Ensures one of THIS SAME scraper's other tasks has run at least once
     * during this run -- a no-op if it already has, otherwise it runs now
     * (satisfying that task's own `dependsOn` first). This is how a task
     * states a real prerequisite without the host needing to guess the
     * right order, and without your own code needing to call the
     * prerequisite's logic directly.
     */
    runTask(id: string): Promise<void>;
}

/**
 * One independently refreshable piece of work, besides the main `build()`.
 *
 * OPTIONAL -- most scrapers have a single source of data and need no
 * `tasks` at all; `build()` alone is a complete, correct scraper. Declare
 * `tasks` only when your source genuinely has parts that change at
 * different rates and are worth refreshing on different schedules -- e.g. a
 * slow full catalogue (twice a day is plenty) alongside a fast-moving
 * live-events feed (useful refreshed hourly). Each task gets its own "Run
 * now" button and, via a `configSchema` field, its own user-settable
 * refresh interval in Settings.
 */
interface ScraperTask {
    /** Stable, unique within this scraper's own `tasks`. */
    id: string;
    /** Shown next to this task's "Run now" button and its last-run status. */
    label: string;
    /** Ids of this scraper's OTHER tasks that must run first, in order,
     *  whether this task was triggered by its own schedule or by hand from
     *  Settings. The host runs each task in the chain at most once per
     *  invocation -- declaring this is the whole story; you never need to
     *  reason about ordering yourself. A cycle here is a bug in this file
     *  and fails loudly rather than hanging. */
    dependsOn?: string[];
    /** The key of a `"number"` field in `configSchema`, read as MINUTES
     *  between automatic runs of this task -- independently of every other
     *  task this scraper declares. Omit for a task that only ever runs as
     *  someone else's dependency, or only by hand. */
    intervalConfigKey?: string;
    run(ctx: ScraperTaskContext): Promise<void>;
}

interface Scraper {
    /** Stable, short, lowercase-dashed. Pick it once and do not rename it
     *  after this scraper has shipped -- it is the namespace every id you
     *  produce lives in, and renaming it orphans every favourite and
     *  watch-progress row a viewer has against your channels. */
    id: string;
    /** Shown in the Settings sources list. */
    name: string;
    /**
     * OPTIONAL, but set it if this scraper will ever be pulled in through
     * Settings > Live TV > Sources > "Import from GitHub" rather than only
     * copied in by hand: dot-separated integers, e.g. "1.2.0". A re-import
     * only ever replaces the copy already running when this is a real
     * increase over it, segment by segment -- an unversioned file can never
     * be known to be newer than anything, so leaving this out means a
     * re-import of this same file is always skipped as "no update", not
     * reapplied. Bump it whenever `build()`'s behaviour changes.
     */
    version?: string;
    /** OPTIONAL. See `ScraperConfigField` above. */
    configSchema?: ScraperConfigField[];
    /** OPTIONAL. See `ScraperTask` above. */
    tasks?: ScraperTask[];
    build(): Promise<ScrapedCatalogue>;
}

/*
    CONFIG VALUES SURVIVE AN UPDATE -- AUTOMATICALLY, FIELD BY FIELD.

    The host stores each scraper's config values keyed by field `key`. When
    you ship a change to `configSchema` -- add a field, remove one, or
    change a field's `type` -- nothing here needs to migrate anything by
    hand: the host reconciles what is stored against your CURRENT schema
    every time it is read. A key you still declare, of the same type, keeps
    whatever value was saved; a key you removed is simply dropped; a key
    that is new, or whose stored value no longer matches its declared type,
    starts at that field's `default`. This is exactly why `key` must be
    stable and never reused for a field with a different meaning -- reusing
    one would silently hand an old value to a field it was never meant for.
*/

// -------------------------------------------------------------------------
// Fill in from here down.
// -------------------------------------------------------------------------

/** Change this. It becomes the second segment of every id this scraper
 *  produces, e.g. "live:my-source:bbc-one". */
const SCRAPER_ID = "my-source";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

/** A bound on any one request, so a hung server cannot hold up the whole
 *  nightly rebuild. Wrap every `fetch` you make in this. */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
        return await work(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * EXAMPLE: a source that publishes one JSON document listing channels and
 * their stream URLs directly. Replace this body with whatever your real
 * source needs -- an M3U playlist parsed by hand, several endpoints
 * combined the way `src/scrapers/iptv-org.ts` does, a scrape of an HTML
 * page, anything -- the only contract is the return type.
 *
 * The example also declares ONE rail, "Exclusives", over whichever of its
 * own channels it marks that way -- to show the shape, not because every
 * scraper should. Delete the `rails` block below if your source has no
 * grouping opinion of its own; that is the common case.
 */
async function build(): Promise<ScrapedCatalogue> {
    const response = await withTimeout((signal) =>
        fetch("https://example.invalid/channels.json", { signal })
    );

    if (!response.ok) throw new Error(`channels.json -> ${response.status}`);

    const raw = (await response.json()) as Array<{
        id: string;
        name: string;
        country?: string;
        logo?: string;
        stream_url: string;
        exclusive?: boolean;
    }>;

    const channels: ScrapedChannel[] = [];
    const exclusiveIds: string[] = [];

    for (const entry of raw) {
        // Skip anything you cannot responsibly offer -- adult content, a
        // channel your source itself marks as dead, and so on. The
        // example below only demonstrates dropping entries with no URL.
        if (!entry.stream_url) continue;

        const id = idFor(entry.id);

        channels.push({
            id,
            name: entry.name,
            country: entry.country || "",
            countryName: entry.country || "",
            countryFlag: "",
            categories: [],
            languages: [],
            logo: entry.logo || "",
            website: "",
            network: "",
            streams: [
                {
                    url: entry.stream_url,
                    quality: "",
                    labels: [],
                    referrer: "",
                    userAgent: ""
                }
            ]
        });

        if (entry.exclusive) exclusiveIds.push(id);
    }

    return {
        channels,
        rails: exclusiveIds.length
            ? [{ id: "exclusives", heading: "Exclusives", channelIds: exclusiveIds }]
            : []
    };
}

/**
 * EXAMPLE configSchema/tasks -- delete both, and the `run()` bodies below,
 * if your source has one uniform refresh rate; build() alone (above) is
 * already a complete scraper. Shown here only because "how do these two
 * connect to build()" is easier to see than to describe: a task's run()
 * writes into a small module-level cache, and build() reads from that same
 * cache -- falling back to fetching directly only the very first time,
 * before either task has ever run (e.g. right after this scraper is first
 * loaded, before the host's scheduler has had its first tick).
 */
let cachedChannels: ScrapedChannel[] | null = null;

const configSchema: ScraperConfigField[] = [
    {
        key: "refreshMinutes",
        label: "Refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 15,
        help: "How often the channel list is re-scraped."
    }
];

const tasks: ScraperTask[] = [
    {
        id: "channels",
        label: "Refresh channel list",
        intervalConfigKey: "refreshMinutes",
        async run() {
            cachedChannels = (await build()).channels;
        }
    }
];

export const myScraper: Scraper = {
    id: SCRAPER_ID,
    name: "My Source",
    // Optional -- see the Scraper interface above. Bump this whenever
    // build()'s behaviour changes; delete the line entirely if this
    // scraper is only ever going to be dropped in by hand.
    version: "1.0.0",
    // Both optional -- delete along with the example block above if this
    // scraper has nothing worth exposing as a setting.
    configSchema,
    tasks,
    build
};

// -------------------------------------------------------------------------
// A quick manual test you can run standalone, before this ever touches the
// real repository: `npx tsx docs/scraper-template.ts` (or compile with
// `tsc` and run with `node`). Prints a channel count, a rail count, and the
// first channel found.
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
