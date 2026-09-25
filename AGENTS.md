# Developing a live-TV scraper for stremio-tv

This repository has no access to [stremio-tv](https://github.com/gauravsuman007/stremio-tv)
(private) and doesn't need any -- everything the contract requires lives in
[`template/scraper-template.mts`](template/scraper-template.mts), a copy of
that repo's own `docs/scraper-template.ts`, kept in sync by hand whenever it
changes there. Read that file's header comment in full before writing
anything; it is the actual spec, not a summary of it. This document is the
workflow around it: how to go from "a source I want to scrape" to a file
that plugs into a running stremio-tv deployment with **zero further
editing**.

## The workflow, start to finish

1. **Copy the template.** `cp template/scraper-template.mts scrapers/<your-id>.mts`
   -- the `.mts` extension is required, not cosmetic (see "Why `.mts`"
   below). Pick `<your-id>` the same way the template's `SCRAPER_ID`
   constant wants it: stable, short, lowercase-dashed, never renamed once
   it ships.
2. **Implement `build()`** against whatever the real source publishes.
   Everything the function owes the rest of the system -- id namespacing,
   what to throw on vs. skip, that ranking and playability checks are the
   host's job, not yours -- is in the template's header. Read
   [`scrapers/ntvst.mts`](scrapers/ntvst.mts) for a worked example that
   fans out across several backends and declares a rail; its own comments
   explain every non-obvious step, which is usually more useful than the
   code itself when adapting this to a similar site.
3. **Run it standalone** before compiling anything:
   ```bash
   npm install
   npx tsx scrapers/<your-id>.mts
   ```
   This actually hits the real source and prints a channel/rail count plus
   the first channel found -- confirm the count looks right and the first
   channel has a real `streams[0].url`, not `undefined` or an empty string.
4. **Compile it** with this repository's own `tsconfig.json`, which mirrors
   stremio-tv's build flags exactly (`--strict --noUncheckedIndexedAccess`,
   target/module `ES2022`, `moduleResolution: bundler`):
   ```bash
   npm run build
   ```
   This must exit clean, zero errors. `--noUncheckedIndexedAccess` is the
   flag every generic TypeScript scraper trips on: it types `array[i]` and
   every regex capture group (`match[1]`) as `T | undefined`, not `T`.
   Fix each one for real (narrow with an `if`, or assert with `!` only
   where a loop bound already guarantees the value exists) -- **never**
   "fix" a compile error by loosening a flag in `tsconfig.json`. A file
   that only compiles under weaker settings will fail again the moment it
   reaches stremio-tv's own stricter build, which is the exact failure
   this workflow exists to prevent.
5. **Set a `version`** on the exported scraper object -- dot-separated
   integers, e.g. `"1.0.0"`. This is what lets stremio-tv's "Import from
   GitHub" (see "Delivering it" below) treat a later change as an UPDATE
   rather than either silently ignoring it or blindly re-copying it every
   time regardless of whether anything changed. Optional for a scraper only
   ever dropped in by hand, but there is no reason not to set it. Bump it
   every time `build()`'s behaviour changes.
6. **Commit `dist/<your-id>.mjs`.** Unlike most projects, this repository's
   compiled output is NOT gitignored -- `npm run build` writes it, and it
   is committed alongside the `.mts` source in the same change. See "Why
   `dist/` is committed" below for why that compiled file, not the source,
   is what actually goes to stremio-tv.

## Config and tasks are optional -- add them only when they earn their keep

The template's `configSchema` and `tasks` (both OPTIONAL, see the template's
header for the full contract) let your scraper expose user-settable knobs
-- an interval, a pacing delay -- and split its work into independently
refreshable, independently schedulable pieces. Most scrapers have one
uniform refresh rate and need neither; `build()` alone is a complete,
correct scraper, and stremio-tv's Settings page simply shows no gear icon
next to one that declares nothing. Reach for `tasks` only when your source
genuinely has parts that change at different rates and are worth refreshing
on different schedules -- [`scrapers/ntvst.mts`](scrapers/ntvst.mts) is the
worked example: its full channel list defaults to a twice-daily refresh,
its live-events rail to hourly, each independently, via two
`configSchema` interval fields and two `tasks` entries.

If you do add either: a task's `run()` is expected to write into a small
module-level cache that `build()` itself reads from (falling back to
fetching directly only if a task hasn't run yet -- see `ntvst.mts`'s
`channelsCache`/`eventsCache`), and a config field's `key` must be
STABLE -- stremio-tv reconciles stored values against your CURRENT
`configSchema` on every read (a removed key is dropped, a new one gets its
`default`, a retyped one is treated as new), so reusing a `key` for a field
with a different meaning would silently hand it an old, unrelated value.

## Why `.mts`, and why the output must be `.mjs`

Node decides whether a `.js` file is an ES module or CommonJS from the
nearest `package.json`'s `"type"` field. The directory a dropped-in
scraper lands in on the stremio-tv side is a bind-mounted data volume with
no `package.json` at all -- so a bare `.js` compiled from this template's
`import`/`export` syntax would default to CommonJS there and fail to
parse. `.mjs` has no such ambiguity; it is always a module, on any host.

Writing the *source* as `<your-id>.mts` (not `.ts`) is what makes `tsc`
emit `.mjs` on its own, correctly, every time -- renaming a `.ts` file's
compiled `.js` output by hand is fragile and easy to forget. `.mts` also
makes `tsc` check the file against Node's actual ESM module-resolution
rules, which plain `.ts` does not, catching a class of import mistakes
`.ts` would silently let through.

## Why `dist/` is committed

stremio-tv's Settings > Live TV > Sources > "Import from GitHub" reads a
configured repository's `dist/` directory directly, over the GitHub API,
and drops whatever `.mjs` files it finds straight into that deployment's
scrapers directory -- no cloning, no build step on that end, because that
container runs no TypeScript compiler at all (same reason the delivered
file has to be `.mjs`, not `.ts`/`.mts`). For that importer to see this
repository's scrapers, the compiled output has to actually be in the
repository, on the branch being imported -- which is the one thing a
normal `dist/` convention (gitignored, rebuilt from source on demand)
would break. So here, `dist/` is tracked: every commit that touches a
scraper's `.mts` source rebuilds it (`npm run build`) and commits the
`.mjs` alongside, in the same change. A source commit without its matching
`dist/` update is a repository in a state the importer cannot use.

## Delivering it

Three ways stremio-tv accepts a finished scraper (all described in the
template's header -- this is the short version):

- **Import from GitHub, no copying at all.** On the stremio-tv side:
  Settings > Live TV > Sources > "Import from GitHub", enter this
  repository (`owner/repo`), a branch, and -- only if this repository is
  private -- an access token. It fetches every `.mjs` in `dist/`,
  validates each one the same way a manual drop-in is validated, and
  writes it in. A LATER re-check of the same repository only replaces a
  scraper already running when the copy in `dist/` now has a strictly
  greater `version` than what is loaded -- which is the entire reason step
  5 above matters. This is the route this repository is built around; the
  other two remain for when GitHub access isn't the way a scraper is
  reaching that deployment.
- **Drop it in, no rebuild.** Copy `dist/<your-id>.mjs` into the
  `scrapers` directory on that deployment's mounted data volume, then
  either restart the container or use the "Reload sources" action on its
  Settings > Live TV > Sources page. It appears immediately, on by
  default, ranked and checked exactly like any other source. Unlike a
  GitHub import, this always overwrites -- there is no version check,
  because copying a file in by hand is already a deliberate choice.
- **Built into the image.** For someone with that repo open: the `.mts`
  source (not the compiled output) becomes `src/scrapers/<your-id>.ts`
  there, added to `BUILTIN` in `src/scrapers.ts`. Needs a rebuild and a
  redeploy on that side; not something to do from here. A scraper
  delivered this way can never be replaced by a GitHub import or a
  drop-in afterward, on purpose -- both routes refuse any id a built-in
  scraper already claims, so `iptv-org` in this repository
  ([`scrapers/iptv-org.mts`](scrapers/iptv-org.mts), a reference port of
  stremio-tv's own built-in copy) can never actually be imported over it.

## What "zero further editing" means in practice

If you're an agent working from this file: the deliverable is judged by
whether `dist/<your-id>.mjs` can be copied straight into a stremio-tv
deployment's `scrapers` directory and picked up with **no changes at all**
on the other end. That means, before calling the scraper done:

- `npm run build` exits with no errors, using this repo's own
  `tsconfig.json` unmodified.
- The compiled file exists at `dist/<your-id>.mjs` (verify the extension
  -- a stray `.js` here means the source wasn't actually named `.mts`), and
  it is COMMITTED, not left gitignored -- see "Why `dist/` is committed".
- `node dist/<your-id>.mjs` runs without throwing an import-time error
  (a quick sanity check that catches, for instance, a top-level await that
  behaves differently once compiled).
- The exported object's shape matches the template's `Scraper` interface
  exactly: `id`, `name`, an OPTIONAL `version`, `build()` -- stremio-tv's
  loader only accepts a module whose `default` export, or one of its named
  exports, looks like that shape, and silently skips (with a logged reason
  on that side, which you won't see from here) anything that doesn't.
- `version` is set and was bumped if this is a change to an existing
  scraper -- an unbumped version means a later "Import from GitHub" /
  "Check for updates" on the stremio-tv side sees no update at all and
  silently keeps running the OLD copy, even though `dist/` now holds
  something different.

## Updating the template

`template/scraper-template.mts` is a manual copy of stremio-tv's
`docs/scraper-template.ts`. If a session working in *that* repo changes
the contract (a new field on `ScrapedChannel`, a new capability like
`ScrapedRail`), it should update the copy here too, in the same commit or
close to it -- this file goes stale otherwise, silently, since nothing
enforces the two staying in sync.
