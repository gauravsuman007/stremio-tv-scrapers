# Developing a live-TV scraper for stremio-tv

This repository has no access to
[stremio-tv-plugin-live-tv](https://github.com/gauravsuman007/stremio-tv-plugin-live-tv)
(the actual consumer of a scraper built here) and doesn't need any --
everything the contract requires lives in
[`template/scraper-template.mts`](template/scraper-template.mts), a richer,
example-augmented copy of THAT repo's own `docs/scraper-template.ts` (itself
a byte-identical copy of its `src/scraper-types.ts` -- the canonical
`Scraper`/`ScrapedChannel`/`ScrapedRail`/... definitions), kept in sync by
hand whenever it changes there -- see that repository's own `AGENTS.md`,
"The contracts this repo sits between, and how they stay linked." (Live TV
is a *plugin* of the separate, private
[stremio-tv](https://github.com/gauravsuman007/stremio-tv) core app, not
built into it -- a scraper here never talks to stremio-tv core directly,
only to the live-tv plugin, so that repo is the one whose contract actually
matters here.) Read the template file's header comment in full before
writing anything; it is the actual spec, not a summary of it. This document
is the workflow around it: how to go from "a source I want to scrape" to a
file that plugs into a running stremio-tv deployment with **zero further
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
4. **Typecheck it locally with this repository's own `tsconfig.json`**,
   which mirrors stremio-tv's build flags exactly (`--strict
   --noUncheckedIndexedAccess`, target/module `ES2022`, `moduleResolution:
   bundler`):
   ```bash
   npm run build
   ```
   This must exit clean, zero errors, before you ever push --
   `--noUncheckedIndexedAccess` is the flag every generic TypeScript
   scraper trips on: it types `array[i]` and every regex capture group
   (`match[1]`) as `T | undefined`, not `T`. Fix each one for real (narrow
   with an `if`, or assert with `!` only where a loop bound already
   guarantees the value exists) -- **never** "fix" a compile error by
   loosening a flag in `tsconfig.json`. A file that only compiles under
   weaker settings will fail again the moment it reaches stremio-tv's own
   stricter build, which is the exact failure this workflow exists to
   prevent. **Leave the `dist/` this produced uncommitted** (`git checkout
   dist`, or just don't `git add` it) -- see "`dist/` is built by CI,
   never locally" below for why.
5. **Set a `version`** on the exported scraper object -- dot-separated
   integers, e.g. `"1.0.0"`. This is what lets stremio-tv's "Import from
   GitHub" (see "Delivering it" below) treat a later change as an UPDATE
   rather than either silently ignoring it or blindly re-copying it every
   time regardless of whether anything changed. Optional for a scraper only
   ever dropped in by hand, but there is no reason not to set it. Bump it
   every time `build()`'s behaviour changes.
6. **Commit and push the `.mts` source only.** CI builds `dist/<your-id>.mjs`
   from a clean checkout and commits it back as `github-actions[bot]` --
   see "`dist/` is built by CI, never locally" below. `git pull` before
   your NEXT commit to this repository; the bot's `dist/` commit will be
   ahead of you.

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

## Why `dist/` is committed, and built by CI, never locally

stremio-tv's Settings > Live TV > Sources > "Import from GitHub" reads a
configured repository's `dist/` directory directly, over the GitHub API,
and drops whatever `.mjs` files it finds straight into that deployment's
scrapers directory -- no cloning, no build step on that end, because that
container runs no TypeScript compiler at all (same reason the delivered
file has to be `.mjs`, not `.ts`/`.mts`). For that importer to see this
repository's scrapers, the compiled output has to actually be in the
repository, on `main` (the importer always reads `main` -- there is no
branch parameter) -- which is the one thing a normal `dist/` convention
(gitignored, rebuilt from source on demand) would break. So here, `dist/`
is tracked, not gitignored.

**But `dist/` is built by CI, never on a developer's or agent's machine.**
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) typechecks and
builds on every push and pull request, and on a push to `main` commits
whatever changed in `dist/` back to `main` itself, as `github-actions[bot]`,
with `[skip ci]` (that commit carries `contents: write` and does not
retrigger the workflow -- a `GITHUB_TOKEN`-authored push never does, so
there's no loop to worry about). A pull request only proves the build
*works*; it does not update `dist/` on that branch. So:

- **Do not run `npm run build` to produce a commit, and do not hand-edit
  or commit `dist/` yourself.** Commit the `.mts` source only. `npm run
  build` locally is fine (encouraged, even -- see step 4 above) for
  confirming the file typechecks before you push; just leave the
  resulting `dist/` changes uncommitted afterward (`git checkout dist`).
- **`git pull` before your next commit to this repository.** The bot's
  `dist/` commit lands on `main` shortly after your push and will be
  ahead of you; basing a new commit on a stale `main` risks a conflict
  against a file you were never supposed to touch by hand in the first
  place.
- A `.mts` source change pushed to `main` is not actually live for
  stremio-tv until **both** the bot's `dist/` commit exists on `main`
  **and** someone presses "Check for updates" on stremio-tv's own Sources
  page -- see "The import only happens when someone presses the button"
  below. If you're verifying a fix end-to-end, that means checking
  `main`'s commit history for the follow-up `Build dist/ [skip ci]`
  commit before assuming the change reached anyone.

This exactly mirrors how the `stremio-tv-plugin-web-scraper` sibling
repository builds its own `dist/` -- see that repository's `AGENTS.md` if
you need the fuller rationale (submodule-pinned contract typechecking,
version bumps, etc. -- this repository's own `version` field on each
scraper object plays the same role its `package.json` version does
there).

**The import only happens when someone presses the button.** stremio-tv
does not poll this repository on a schedule or at boot -- once a scraper
is imported it is read from stremio-tv's own mounted volume at every
subsequent boot, with no further dependency on GitHub being reachable,
until "Check for updates" is pressed again by hand.

## Delivering it

Three ways stremio-tv accepts a finished scraper (all described in the
template's header -- this is the short version):

- **Import from GitHub, no copying at all.** On the stremio-tv side:
  Settings > Live TV > Sources > "Import from GitHub", enter this
  repository (`owner/repo`) and -- only if this repository is private --
  an access token; there is no branch field, it always reads `main`. It
  fetches every `.mjs` in `dist/`, validates each one the same way a
  manual drop-in is validated, and writes it in. A LATER re-check of the
  same repository only replaces a scraper already running when the copy in
  `dist/` now has a strictly greater `version` than what is loaded --
  which is the entire reason step 5 above matters. This is the route this
  repository is built around, and the route
  [`scrapers/ntvst.mts`](scrapers/ntvst.mts) actually reaches a stremio-tv
  deployment by -- stremio-tv ships with nothing built in, so this is not
  a fallback route for it. (iptv-org used to reach stremio-tv this same
  way; it has since moved into the stremio-tv-plugin-live-tv repository
  itself as that plugin's bundled default scraper, and its copy here is
  archived -- see [`archive/iptv-org.mts`](archive/iptv-org.mts) and the
  README.)
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
  redeploy on that side; not something to do from here, and not how any
  scraper in this repository is delivered today -- `BUILTIN` is empty on
  stremio-tv by default. A scraper delivered this way can never be
  replaced by a GitHub import or a drop-in afterward, on purpose -- both
  routes refuse any id a built-in scraper already claims.

## What "zero further editing" means in practice

If you're an agent working from this file: the deliverable is judged by
whether `dist/<your-id>.mjs` -- the one CI produces after your commit, not
one built by hand -- can be copied straight into a stremio-tv deployment's
`scrapers` directory and picked up with **no changes at all** on the
other end. That means, before calling the scraper done:

- `npm run build` exits with no errors LOCALLY, using this repo's own
  `tsconfig.json` unmodified -- as a typecheck only. Do not commit the
  `dist/` this produces (see "`dist/` is built by CI, never locally").
- After pushing, CI's own build (same command, clean checkout) also
  succeeds -- check the workflow run, don't just assume a local pass
  means the same thing happened in CI.
- The bot's `Build dist/ [skip ci]` follow-up commit lands on `main` (`git
  pull` and check the log, or check the Actions tab) -- a source commit
  with no matching `dist/` update yet is a repository mid-flight, not yet
  in a state stremio-tv's importer can use.
- `node dist/<your-id>.mjs` (the CI-built copy, pulled after the bot's
  commit) runs without throwing an import-time error -- a quick sanity
  check that catches, for instance, a top-level await that behaves
  differently once compiled.
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

## Keep `SOURCES.md` current

[SOURCES.md](SOURCES.md) tracks every live-TV/live-sport source considered
for this repository -- implemented, backend-blocked, possible, untriaged or
rejected, with the reason for whichever status applies. Read it before
triaging a new source: a candidate may already be marked rejected (with
why), or noted as probably sharing a backend `ntvst.mts` or `zlive.mts`
already resolved or hit a wall on. Update it in the same commit whenever a
source's status changes -- an agent picking this up next has only this
file and the scrapers themselves to go on, not this session's chat history.

## Reverse-engineering a source that isn't plain JSON or HTML

Most sources are a JSON API or an HTML page you can parse directly. Some
gate their real stream URL behind client-side JavaScript -- WebAssembly,
an obfuscated bundle, a signed/encrypted request body -- and it's tempting
to give up and call the source unscrapable. Don't, until you've actually
tried running the gate rather than reading it. The general principle,
proven on both `ntvst.mts`'s `cdnlive` backend and `zlive.mts`'s
`/resolve` endpoint: **run the site's own code to see what it does, don't
hand-decode an obfuscated bundle line by line.** A modern JS engine
(Node) can execute almost anything a browser can, given the right stubs;
finding which globals it actually touches is far less work than reversing
what a minifier did to the source.

### Running an obfuscated bundle in Node to recover a crypto/signing scheme

This is how `zlive.mts`'s AES-GCM envelope was found. The site's channel
list was plain JSON, but resolving a channel's opaque key into a real
stream URL needed a `POST` whose body only the site's own minified JS
could produce -- no amount of reading the string-array-obfuscated source
by hand was going to recover it in reasonable time.

1. **Download the real bundle** (`curl` the `<script src>` the page
   loads) and confirm it's self-contained (no further `import`s of other
   chunks) -- most single-page-app entry bundles are, since a bundler
   inlines everything reachable from the page's own routes.
2. **Load it in `node:vm`** (`vm.createContext` + `vm.runInContext`) with
   browser globals stubbed just enough for it to parse and start running:
   `document`, `window`/`self`/`globalThis` all pointing at the same
   sandbox object, `TextEncoder`/`TextDecoder`, `crypto` (Node's own
   `require("crypto").webcrypto` -- has `.subtle`, unlike a stub object),
   `MutationObserver`/`ResizeObserver`/`IntersectionObserver` as no-op
   classes, `URL`/`URLSearchParams`/`Headers`/`Request`/`Response`/`Blob`
   copied straight from Node's own globals (they exist there already,
   just not inside the fresh `vm` context), and a `fetch` stub that
   **throws an error containing the full request** (url, method, headers,
   body) rather than actually going to the network. Function declarations
   at a script's top level become properties of the sandbox object even
   if the script throws partway through -- but `const`/`let` bindings do
   not, so a function you want to call directly afterward needs to be
   declared with `function`, not assigned as `sk = ...`.
3. **Call the function that builds the request directly**, wrapped in a
   `.catch()` that prints the thrown fetch stub's message -- this is the
   *exact* request the real client would have sent, headers and encrypted
   body included, with no manual reconstruction. Replay it verbatim with
   `curl` (write the body to a file first and use `--data-binary @file`
   -- shell quoting mangles base64's `+`/`/` easily enough to cost you an
   hour chasing a phantom bug) to confirm the server accepts it before
   going any further.
4. **If step 2 throws before reaching the function you need** (a bundled
   React app's own bootstrap trying to `ReactDOM.createRoot(...).render()`
   against a `document.getElementById` that returns `null`, for example),
   either accept the partial failure -- function declarations still
   hoisted, per above, so you may already have what you need -- or reach
   for `jsdom` (`npm install jsdom` in the repo's scratch directory,
   never as a dependency of the shipped scraper) for a real enough DOM
   that the app actually mounts. `jsdom`'s `window.crypto` is a
   **read-only, non-configurable-looking property that a plain assignment
   silently fails to override** -- use
   `Object.defineProperty(window, "crypto", { value: nodeWebcrypto,
   configurable: true })`, not `window.crypto = nodeWebcrypto`, or every
   `crypto.subtle` call inside the app will throw on a real `undefined`
   sub-property while looking like it should have worked.
5. **Once the request goes through, instrument rather than decode** the
   crypto primitives themselves to learn the exact algorithm without
   tracing the obfuscator's string-array indirection by hand at all:
   wrap `crypto.subtle.digest`/`.importKey`/`.encrypt` so each call logs
   its real arguments (the plaintext being hashed, the raw key bytes, the
   IV, the plaintext being encrypted) before delegating to the real
   implementation. This turns "reverse-engineer a signing scheme" into
   "read the log" -- it found `zlive.st`'s exact key derivation (SHA-256
   of a fixed salt plus the current date, used directly as a raw AES-GCM
   key, no HKDF) in one run, where manually decoding the obfuscated
   property-name indirection around it would have taken far longer for
   the same answer.
6. **Port the recovered algorithm into clean, un-obfuscated TypeScript**
   in the shipped scraper -- using Node's real `crypto.webcrypto`
   directly, not the site's own minified functions. Never ship obfuscated
   third-party JS, or a `vm`/`jsdom` sandbox, inside a scraper that
   reaches stremio-tv; those are research-only tools for this repository,
   the same way `node:vm` is for the web-scraper sibling repository (see
   its AGENTS.md) -- not a security boundary, and not something a
   `build()` call should depend on at runtime.

### WASM-gated sources

The same "run it, don't decode it" principle applies to a source that
needs a WebAssembly module (minting an id, deriving a key, decrypting a
payload) to produce its stream URL. This repository has no `BrowserSite`
fallback at all -- `Scraper.build()` only ever returns a URL, so a source
whose gate cannot be made to run outside a real browser is not a slower
version of working, it's unscrapable, full stop. That raises the bar for
trying properly before giving up:

- **Load the `.wasm` directly in Node** with `WebAssembly.instantiate`
  and the site's own JS glue (a `wasm_exec.js`-style shim for Go; a
  thinner one for Rust/AssemblyScript). Stub only the couple of browser
  globals the shim actually touches rather than assuming it needs a real
  DOM -- most modules touch two or three browser APIs and the rest of a
  generic shim template is dead weight.
- **Disassemble the module** (`wasm2wat`/`wabt`, or Chrome DevTools' own
  WASM debugger) when the glue doesn't make the entry point obvious.
  Compare against the JS wrapper that calls it to see which export is
  used and how arguments are encoded (pointer+length into linear memory
  is the common case).
- **Confirm you can reproduce one known input/output pair** (captured
  from a real browser session -- a DevTools breakpoint on the JS
  wrapper, or a patched `console.log`) running the same module in Node
  before trying to understand its internals; then treat the module as a
  black box you invoke rather than something you need to fully
  understand.
- **`instance.exports` is frozen** -- assigning a wrapper into it does
  nothing. To see what an export takes and returns, wrap
  `WebAssembly.instantiate`/`instantiateStreaming` (in a real browser, via
  something like Playwright's `addInitScript`) and hand the page a
  substitute `{ module, instance: { exports: { ...wrappers } } }`
  instead, dumping linear memory at each pointer argument before and
  after the call.
- **Only ever ship zero-import `.wasm`.** Check
  `WebAssembly.Module.imports(module).length === 0` at load time -- such
  a module can only compute, it cannot fingerprint the caller. A module
  with imports into canvas/`navigator`/`localStorage` reads as "needs a
  real browser" until a trace shows they only feed an anti-bot check
  around an otherwise-pure computation (recover the algorithm instead of
  the module: scan linear memory for a key against known ciphertext,
  instrument internal functions by redirecting an existing, unused import
  of matching type to a sentinel logger). Never ship a module with
  imports, native or otherwise -- reimplement what it computes.
- **When it genuinely can't run standalone** -- it fingerprints its
  environment, needs a real event loop tied to page lifecycle, or checks
  its output against something only the live page can supply -- there is
  no `BrowserSite` to fall back to here. Skip the source (the way
  `ntvst.mts` skips `dlhd` channels) and document exactly what was tried
  and why it didn't work, in the scraper's own docstring, so the next
  attempt doesn't repeat the dead end.

### Getting past Cloudflare/Turnstile with FlareSolverr, for research only

A source sitting behind a Cloudflare challenge is worth checking the same
way: [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) runs a
real, patched browser behind a small HTTP API and hands back cleared
cookies (`cf_clearance` etc.), the User-Agent it solved with, and the
page body. Run it once (`docker run -p 8191:8191
ghcr.io/flaresolverr/flaresolverr`) and `POST http://localhost:8191/v1`
with `{"cmd":"request.get","url":"...","maxTimeout":60000}` against
whichever host actually holds the challenge (the HTML page, or the API
host directly, if the challenge sits there instead). Use the returned
cookies and User-Agent for your own research fetches -- finding the real
stream endpoint, confirming it's reachable -- exactly as you would a
captured browser session.

This is a research tool for finding the recipe, never something a shipped
scraper depends on at request time: **`ScrapedStream` has no `headers`
field and no way to carry a cookie at all** (only `referrer` and
`userAgent` -- see "What this scraper contract cannot do" below), so a
source whose *stream itself* (not just the page that reveals it) needs
`cf_clearance` to keep working is unscrapable here regardless of how it
was found, the same as a WASM source whose gate can't run outside a real
browser. `cf_clearance` is also short-lived and tied to the solving
IP/UA pair -- it will not survive being solved in one place and used from
stremio-tv's own server IP even if the contract had somewhere to put it.

### What this scraper contract cannot do -- recognise a dead end early

Before sinking hours into a source, check whether solving it would even
produce something `Scraper.build()` can return. The contract
(`template/scraper-template.mts`) is a **static URL plus two optional
strings** (`referrer`, `userAgent`) -- nothing else. That rules out, and
is worth recognising *before* spending a research session on:

- **A source needing a cookie, custom header, or signed request repeated
  on every segment fetch**, not just the initial playlist. `ntv.st`'s
  `dlhd` backend is the worked example: the playlist URL itself resolves
  in the clear with plain HTTP, but every segment it lists is a real PNG
  with the actual video steganographically hidden in its pixel data,
  requiring a decode step per segment, forever, for a live stream. There
  is nowhere in this contract to run an ongoing transform -- it would
  need a proxy sitting in front of the CDN, which is a host-level
  capability, not something a scraper can provide. Recognising this
  shape early (one-time gate vs. a gate that repeats on every request the
  player itself makes) saves the time `dlhd` cost before it was
  correctly re-diagnosed as an architectural limit rather than an
  unsolved cracking problem (see `ntvst.mts`'s docstring for the full
  history).
- **A source whose stream needs a `Cookie` header**, from a Cloudflare
  clearance or otherwise: there is no field for it. Unlike the
  `stremio-tv-plugin-web-scraper` sibling repository (whose relay can be
  extended to allow `Cookie` with a host-side change -- see that
  project's `AGENTS.md`), this repository has no relay in the loop at
  all: stremio-tv's player fetches the URL you return directly. Adding
  `Cookie` support here would mean changing `ScrapedStream` itself (a
  stremio-tv-side change, not something this repository controls) and
  updating `template/scraper-template.mts` to match -- worth raising, not
  worth assuming your scraper alone can route around.
- **A source that behaves differently by caller IP.** A resolve that
  works from a laptop can legitimately return nothing (or a different
  provider entirely) from stremio-tv's own server -- the sibling
  `stremio-tv-plugin-web-scraper` repository has seen sites pick a CDN
  provider by the caller's address (see its AGENTS.md, "The same site can
  serve a different player depending on the caller's IP"). If a scraper
  that resolves cleanly in research returns nothing once actually
  deployed, suspect this before suspecting the algorithm.

### Segment decoders: the one ongoing transform the contract CAN carry

Since stremio-tv plugin API 1.2.0 / Live TV plugin 1.6.0, a stream may name
a `decoder` from its scraper's own `decoders` map (see the template). The
plugin relays every request of such a stream -- playlist, variants,
segments, keys -- and runs the decoder on each segment. This is exactly
what `dlhd` needed (the bullet above describes the problem as it stood):
`scrapers/dlhd.mts` is the worked example. Two consequences worth knowing:

- `referrer` and `userAgent` are now sent on every segment too, not only
  on the playlist -- core never sent them before, so a Referer-locked CDN
  used to pass the plugin's checks and fail on the television.
- A decoder is pure computation over bytes, run on the server for every
  segment of every viewer. It still cannot add a cookie, sign each
  request, or talk to the network; those remain dead ends here.

## Updating the template

`template/scraper-template.mts` is a manual copy of
stremio-tv-plugin-live-tv's `docs/scraper-template.ts` (itself a copy of
that repo's `src/scraper-types.ts` -- see the chain in that repo's
`AGENTS.md`). If a session working in *that* repo changes the contract (a
new field on `ScrapedChannel`, a new capability like `ScrapedRail`, a
change to the merge/rail-heading/priority rules), it should update the
copy here too, in the same commit or close to it -- this file goes stale
otherwise, silently, since nothing enforces the two staying in sync. When
starting work here, it is worth a quick diff against that repo's
`docs/scraper-template.ts` to confirm this copy hasn't already drifted.
