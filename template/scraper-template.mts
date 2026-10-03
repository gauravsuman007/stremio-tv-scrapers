/**
 * TEMPLATE: a live-TV scraper for live-tv.
 * ========================================
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
 *         const BUILTIN: Scraper[] = [myScraper];
 *
 *     Needs a rebuild and a redeploy, worth it only for a source the
 *     deployment should never run without even after a wiped data volume --
 *     nothing is built in by default.
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
    /** HTTP Referer this stream needs, or "". Sent on EVERY request the
     *  stream makes -- playlist, variants, segments, keys -- because the
     *  live-tv relays all of them. */
    referrer: string;
    /** User-Agent this stream needs, or "". Sent the same way. */
    userAgent: string;
    /**
     * OPTIONAL. Further request headers, sent on every request the stream
     * makes (playlist, variants, segments, keys): `Origin`, a token header,
     * `Cookie`. Names are free; `Host`, `Content-Length`, `Accept-Encoding`,
     * `Range`, `User-Agent` and `Referer` are ignored (use the two fields
     * above); at most 16, values up to 4 KB, no line breaks. `Cookie` and
     * `Authorization` go only to the host the stream's own address is on,
     * and are dropped on a redirect to another host; ClearKey streams get
     * neither. STATIC: a header that must differ on every request cannot be
     * carried -- a per-play cookie belongs in a resolver, which may return
     * `headers` too. Needs live-tv 1.9.0; an older host ignores the field.
     */
    headers?: Record<string, string>;
    /**
     * OPTIONAL. The name of an entry in this scraper's own `decoders`
     * (see `Scraper.decoders` and `SegmentDecoder` below) that every
     * SEGMENT of this stream must pass through before a player can read it.
     * Leave it out for an ordinary stream -- which is nearly all of them.
     *
     * For a CDN that disguises its video: dlhd's segments are real PNG
     * images with the MPEG-TS packed into their pixels (see `dlhd.mts`).
     * live-tv relays the stream, reads each playlist as it passes so it
     * knows every segment URL in it, and runs your decoder on each segment
     * on the way to the player. Playlists themselves are never decoded.
     *
     * A NAME, not the function, because your catalogue is stored as JSON
     * between runs. A name with no matching decoder -- or a live-tv too
     * old to relay segments -- drops the stream rather
     * than handing a player a picture.
     */
    decoder?: string;
    /**
     * OPTIONAL. The name of an entry in this scraper's own `resolvers`
     * (see `Scraper.resolvers`) that turns this stream's `url` into a
     * playable one AT THE MOMENT IT IS NEEDED. Leave it out for an ordinary
     * stream -- nearly all of them.
     *
     * For a source whose playable address cannot be written down ahead of
     * time: it is signed and expires, is bound to the caller, or is minted
     * by a handshake that must be repeated. Resolved once at scrape time
     * such a URL is stale by the time anyone presses Play.
     *
     * With a resolver, `url` is a HANDLE: any stable, unique URL naming the
     * stream (convention: `https://<scraper id>.invalid/<key>` -- a host
     * that never resolves, so a handle that escaped fails cleanly). It is
     * what the host stores evidence against and ranks by, and it is NEVER
     * fetched. The host calls the resolver for every check, probe and play
     * and fetches what it returns. A NAME, because the catalogue is JSON.
     */
    resolver?: string;
    /**
     * OPTIONAL. Marks `url` as a DASH manifest (`.mpd`) whose media is
     * ENCRYPTED with Common Encryption ("cenc", AES-CTR), and gives the
     * ClearKey that opens it. Leave it out for an ordinary stream.
     *
     * For sources that restream a DRM-protected channel and publish the key
     * beside it (a player page holding `kid:key` for Shaka or dash.js).
     * A television's browser cannot be handed a key through a URL, so the
     * HOST does it: ffmpeg opens the manifest with the key, copies the
     * decrypted video and audio (no re-encode) into ordinary HLS segments,
     * and the player is served that. To the viewer it is an HLS channel.
     *
     * `url` is the real manifest address, not a handle (but a stream with
     * a `resolver` may have the resolver return `clearKey` instead -- see
     * `ResolvedStream`). `referrer` and `userAgent` are sent on the manifest
     * and on every segment, as for any stream. It does not combine with
     * `decoder`: the host's own output is ordinary video.
     *
     * One key pair only: it must open every track the stream carries,
     * which is what these sources do in practice. A stream whose audio and
     * video use different keys cannot be expressed and should be left out.
     * Widevine, PlayReady and FairPlay are not ClearKey and are not
     * supported by anything here -- do not hand one over.
     *
     * Needs live-tv 1.8.0 and an `ffmpeg` on the host; without
     * both the stream is dropped, not offered broken. The host checks such a
     * stream as far as its manifest (reachable, really an MPD); whether the
     * key is right is only found out when someone plays it.
     */
    clearKey?: ClearKey;
}

/**
 * A ClearKey pair, both 32 hex characters (16 bytes). `key` decrypts;
 * `kid` is the key id the manifest names and is kept for the record --
 * the host does not need it to decrypt. See `ScrapedStream.clearKey`.
 */
interface ClearKey {
    kid: string;
    key: string;
}

/**
 * Turns one segment, exactly as the CDN served it, into what a player
 * expects -- normally MPEG-TS (188-byte packets, each starting `0x47`).
 * `url` is the segment's own address. Throw if the bytes are not what you
 * expected: that one segment then fails, and the player moves on.
 *
 * Runs on the live-tv server for every segment of every viewer, so keep
 * it pure computation over the bytes: no network, no state between calls.
 * `node:zlib` and `node:crypto` cover what this usually takes.
 */
/** What a resolver returns: the real address, plus the headers it needs if
 *  they differ from the stream's own. `null` (or a throw) means "cannot be
 *  resolved right now": a dead mirror, tried again on the next press. The
 *  host reuses an answer for about five minutes and gives a resolver about
 *  twelve seconds -- it is on the way to a press of Play. */
interface ResolvedStream {
    url: string;
    referrer?: string;
    userAgent?: string;
    /** Replaces the stream's own `headers` when given (see `ScrapedStream.headers`). */
    headers?: Record<string, string>;
    /** The key for a stream that is encrypted (see `ScrapedStream.clearKey`),
     *  when the resolver is what knows it -- a signed manifest and its key
     *  often change together. Overrides the stream's own. */
    clearKey?: ClearKey;
}

/** `handle` is the stream's own `url`. */
type StreamResolver = (handle: string) => Promise<ResolvedStream | null>;

type SegmentDecoder = (segment: Uint8Array, url: string) => Uint8Array | Promise<Uint8Array>;

/**
 * WHAT A LIVE EVENT IS, SAID BY THE SOURCE THAT KNOWS. A fixture is not its
 * name: seven sources write "Canada vs Peru", "Peru vs Canada", "UEFA Nations
 * League : Peru vs Canada" and the host cannot tell them from three
 * different matches by the text alone. So say who is in it and when.
 *
 * Name the card `Team A vs Team B` (any number of sides, "A vs B vs C") -- the
 * participants only, no competition or round glued on, no flag or "HD" -- and
 * put the rest here. The host matches two cards as ONE event when their
 * `sides` agree in any order (accents, "FC", "Czech Republic"/"Czechia" are
 * folded) and, if both give a `start`, those are within eight hours.
 *
 * Every field is optional; give what the source actually has and never invent
 * one -- a guessed `start` splits a fixture in two, a guessed side merges two.
 * A card with no `event` still merges when its `name` reads "A vs B", but
 * `event` is the sure way.
 */
interface ScrapedEvent {
    /** The participants, as the source writes them: ["Canada", "Peru"]. Two or
     *  more, or leave it out (a race, a card, a festival has none). */
    sides?: string[];
    /** The event's own title when there are no sides: "World Grand Prix, Day 6".
     *  Used to match title-only events from different sources. */
    title?: string;
    /** "UEFA Nations League", "UFC 332", "Friendlies". Shown, never matched on. */
    competition?: string;
    /** "football", "cricket", "mma", "darts" ... lowercase, free text. */
    sport?: string;
    /** Scheduled start, EPOCH MILLISECONDS. Omit when unknown -- never 0. */
    start?: number;
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
    /**
     * OPTIONAL. Two pictures for ONE card, drawn side by side on a single
     * tile -- a fixture's two flags or crests ("India" | "West Indies").
     * Leave it out for an ordinary channel. When it is present, `logo` must
     * still be set (to the first picture): a host that predates this field
     * shows `logo` alone, and a card whose logo is empty is given a name pill.
     * Direct image URLs, as `logo`; at most the first two are used. The
     * pair is only drawn when BOTH could be fetched; otherwise the card falls
     * back to `logo`. When two sources' cards for the same event merge, the
     * merged card takes `logo` and `logos` from whichever source has them.
     */
    logos?: string[];
    /**
     * OPTIONAL. What a live EVENT is, stated rather than left to be read out
     * of `name` -- the way cards from different sources become one card.
     * Leave it out for an ordinary channel. See `ScrapedEvent`.
     */
    event?: ScrapedEvent;
    website: string;
    network: string;
    /** At least one, or the channel is dropped centrally -- no need to
     *  filter empty-stream channels out yourself, but you may. */
    streams: ScrapedStream[];
}

/*
    ONE MORE THING THAT HAPPENS TO `name`/`country` CENTRALLY, AFTER
    `build()` RETURNS: a channel (or a live event -- the same type) whose
    folded `name`+`country` matches one already in the index, from another
    scraper (iptv-org's own built-in list included), is not added as a
    second card. Its `streams` are appended to the EXISTING channel's
    mirror list instead, each one still remembered as having come from
    this scraper for the source list's own badge -- you never see this
    happen and never need to give it a matching key yourself, it just
    means a channel your scraper returns may end up sharing a card, and a
    higher score, with someone else's entry rather than getting its own.
    A non-iptv-org mirror gets a small, deliberately modest preference over
    an iptv-org one when nothing else (verified liveness, codec) has
    already told the two apart -- write `name` the way a human would say
    it (no "(HD)", no "[Backup]") so this actually recognises the channel
    it is the same as.
*/

interface ScrapedRail {
    /** A short slug, unique within THIS scraper only, `[a-z0-9-]` and 40
     *  characters or fewer -- e.g. "anime-simulcasts". The final id shown
     *  to a viewer is built centrally as `rail:<your-scraper-id>-<this>`,
     *  so two scrapers can both call theirs "sport" with no collision. */
    id: string;
    /** Shown as the rail's heading, same as any other rail -- and the ONE
     *  place two different scrapers deliberately share text rather than
     *  namespacing away from each other. A rail from this scraper and a
     *  rail from another whose `heading`, trimmed and case-folded, reads
     *  the same are merged centrally into a single rail carrying both
     *  scrapers' channels (deduplicated the same way a repeated channel
     *  is, see `ScrapedChannel` above) rather than shown as two rails with
     *  the same title. If your source has a live-events rail, call it
     *  exactly "Live Events" so it merges with any other scraper's -- a
     *  viewer wants one events rail with several sources per event, not
     *  one per scraper. Do NOT do this by accident: a generic heading like
     *  "Sports" from two unrelated scrapers would merge the same way, so
     *  pick a heading that only means "merge with me" when you mean it. */
    heading: string;
    /** Ids of channels THIS SAME `build()` call also returned in
     *  `channels`. An id belonging to another scraper, or one this call
     *  did not itself return, is dropped rather than resolved -- a rail is
     *  not a way to reach into somebody else's catalogue. Leave it `[]`
     *  when the rail is described by `filter` instead. */
    channelIds: string[];
    /** Shown small beside the heading ("Most widely carried"). Defaults to
     *  "From <your scraper's name>". */
    by?: string;
    /** OPTIONAL. Where this rail sits in the lists of every rail: up to three
     *  names joined by "/" ("Genres", "Countries/Europe"). Each name is a group
     *  that opens and closes. Rails with no group are listed beside the groups. */
    group?: string;
    /** Describes the rail instead of listing it: the host fills it from
     *  the finished index, ranked like every rail (what last night's check
     *  proved first) and for the household looking, so a rail that means
     *  "all of X" -- a country, a language, a genre -- never goes stale.
     *  `channelIds` is ignored when this is present, and a filter rail is
     *  never merged with another by heading. Every field present must
     *  match; within a field any value does. See scrapers/iptv-org.mts. */
    filter?: {
        /** Country codes as your channels carry them in `country`. */
        countries?: string[];
        /** Your channels' own `categories` words. */
        categories?: string[];
        /** The host's genre ids, which fold every source's categories onto
         *  one vocabulary: news, entertainment, movies, sports, kids, music,
         *  documentary, lifestyle, business, devotional, general. */
        genres?: string[];
        /** ISO 639-3 codes on a channel's main feed. */
        languages?: string[];
        /** Network names as your channels carry them in `network`, case-folded. */
        networks?: string[];
        /** Ids of sources: "everything on <your scraper id>". */
        sources?: string[];
        /** "home-first" lifts the household's own countries above the rest;
         *  "first" keeps only the household's first market. Omitted: the same
         *  for everyone. */
        market?: "home-first" | "first";
    };
}

/** A page to start the Live TV app with: a title and which of THIS
 *  scraper's rails it carries, in order. Only a suggestion for a television
 *  nobody has edited; anyone can add, remove and rearrange pages and rails
 *  in Settings > Site layout. Pages from several scrapers with the same id
 *  are one page. `rows`: 1 (default) is one line that scrolls sideways, n is
 *  n lines scrolling together, 0 is as many as it takes to show everything
 *  with no sideways scrolling. */
interface ScrapedPage {
    /** Slug, `[a-z0-9-]`, 32 characters or fewer. */
    id: string;
    title: string;
    rails: { id: string; rows?: number }[];
}

interface ScrapedCatalogue {
    channels: ScrapedChannel[];
    /** Leave out entirely if you have no opinion about grouping -- most
     *  scrapers do, and that is the normal case, not a missing feature. */
    rails?: ScrapedRail[];
    /** Likewise optional: pages the app should start with. */
    pages?: ScrapedPage[];
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
    /** OPTIONAL. Named segment decoders, referenced by
     *  `ScrapedStream.decoder`. See `SegmentDecoder` above. */
    decoders?: Record<string, SegmentDecoder>;
    /** OPTIONAL. Named stream resolvers, referenced by
     *  `ScrapedStream.resolver`. See `StreamResolver` above. */
    resolvers?: Record<string, StreamResolver>;
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
