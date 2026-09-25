# stremio-tv-scrapers

Live-TV/sports scrapers for [stremio-tv](https://github.com/gauravsuman007):
24/7 channels and live sporting events, scraped straight from a site's own
CDN with no torrent or debrid step. Each file is a standalone `Scraper`
(one `build()` function returning a full catalogue) that compiles to a
plain `.mjs` file in [`dist/`](dist), committed (not gitignored) so
stremio-tv's Settings > Live TV > Sources > "Import from GitHub" can read
it straight from this repository — no cloning, no manual copying, and a
later re-check only replaces a scraper here with a genuinely newer one (see
"Versioning" in AGENTS.md).

**Developing a new one: read [`AGENTS.md`](AGENTS.md) first.** It's the
full workflow — copy [`template/scraper-template.mts`](template/scraper-template.mts),
implement `build()`, set a `version`, compile, verify — written so an agent
working only in this repository can produce a file that plugs into
stremio-tv with no further editing.

## [`scrapers/ntvst.mts`](./scrapers/ntvst.mts) — ntv.st

~10.4k 24/7 live channels plus a live sporting-events rail. ntv.st
multiplexes three unrelated backends behind one channel list:

- `cdnlive` (~4% of channels) — stream URL hidden behind per-request
  randomised JS variable names around a fixed assembly shape.
- `hesgoales` (~87%, the largest) — itself two unrelated sites:
  `hesgoal.team` → `wideiptv.top` (plain JS literal, no obfuscation), and
  `epicsports-tv.com`, whose `decode.php` takes the channel id from the
  `Referer` header (not a query param) and is genuinely flaky, succeeding
  roughly half the time.
- `dlhd` (~9%) — not resolved. Domain-locked, and actively
  anti-tamper-protected: confirmed by running the extracted payload in a
  sandboxed Node `vm` (stubbed browser globals, no real network), where
  patching `Function` to trace calls caused the code to detect the
  instrumentation and sabotage its own execution.

Coverage: `cdnlive` + all of `hesgoales` ≈ **~91% of the channel catalogue**.

Also builds a live-events rail from ntv.st's own sporting-events feed,
grouped by category into `ScrapedRail`s and resolved down to bare `.m3u8`
URLs. It deliberately targets ntv.st's `falcon` mirror server rather than
`kobra` (the homepage tab's own default): `kobra`'s events all dead-end at
the same unresolved `dlhd`-family backend, while `falcon` resolves cleanly
through `livelive24.com` (plain base64 or urlencoded `.m3u8` links, no
obfuscation) — a different, though mostly disjoint, event catalogue in
exchange for URLs that actually play.

Read the source comments — every non-obvious step is explained with *why*,
not just what the code does; that context is usually more useful than the
code itself when adapting this to a similar site.

### Trying it standalone

```bash
npm install
npx tsx scrapers/ntvst.mts
```

Prints the resulting channel/rail counts and the first channel. ntv.st
rate-limits fairly aggressively under a BURST of back-to-back pagination
requests -- confirmed empirically, not just from the API's own error
messages -- so `fetchAllChannels` paces page requests 250ms apart rather
than firing them as fast as the network allows; that alone was enough to
clear the entire ~12k-channel catalogue with zero 429s in testing.
`fetchText`'s retry-with-backoff stays as a safety net for the still-real
case of a legitimate burst against a THIRD-PARTY host during channel
resolution (`resolveHesgoal`, `resolveEpicsports`), which pacing on
ntv.st's own pagination cannot help with.

## [`scrapers/iptv-org.mts`](./scrapers/iptv-org.mts) — iptv-org

A second worked example, ported from stremio-tv's own built-in copy: a
source that already publishes clean JSON across a handful of small
endpoints (channels, streams, feeds, logos, countries, a blocklist) rather
than one that needs reverse-engineering. Useful as a template for a
similarly well-behaved API even though this exact file can never actually
be imported into a stremio-tv deployment — its id, `iptv-org`, is already
claimed by that app's own built-in scraper, and both the GitHub importer
and a manual drop-in refuse to let anything else use an id a built-in
scraper already has.

## The contract

Every resolved stream URL is short-lived (minutes, not hours) and often
IP-bound; nothing here should be cached — `build()` is meant to be called
fresh at each catalogue rebuild, and the app re-fetches a channel's stream
at playback time rather than reusing whatever `build()` returned earlier.

## License

GPL-3.0.
