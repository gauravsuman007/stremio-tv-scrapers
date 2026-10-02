# stremio-tv-scrapers

Live-TV/sports scrapers for [stremio-tv](https://github.com/gauravsuman007):
24/7 channels and live sporting events, scraped straight from a site's own
CDN with no torrent or debrid step. stremio-tv ships with nothing built
in — every active scraper here is how it actually gets its live-TV
channels, including iptv-org, the default scraper of the standalone
[live-tv](https://github.com/gauravsuman007/live-tv) app. Each file is a
standalone `Scraper` (one `build()`
function returning a full catalogue) that compiles to a plain `.mjs` file
in [`dist/`](dist), committed (not gitignored) so stremio-tv's Settings >
Live TV > Sources > "Import from GitHub" can read it straight from this
repository (always `main` — there is no branch field) — no cloning, no
manual copying, and a later re-check only replaces a scraper here with a
genuinely newer one (see "Versioning" in AGENTS.md). stremio-tv does not
poll this repository on its own; a scraper is only re-fetched when someone
presses "Check for updates".

**Developing a new one: read [`AGENTS.md`](AGENTS.md) first.** It's the
full workflow — copy [`template/scraper-template.mts`](template/scraper-template.mts),
implement `build()`, set a `version`, compile, verify — written so an agent
working only in this repository can produce a file that plugs into
stremio-tv with no further editing. [`SOURCES.md`](SOURCES.md) tracks every
source considered — implemented, blocked, possible or untriaged — so a new
session can pick up the list without re-triaging from scratch.

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
- `dlhd` (~9%) — not resolved, but for an architectural reason now, not a
  cracking failure: the iframe chain (`dlhd.st` → `daddyliveplayer.st`, a
  "DaddyLive"-family player) hands back a bare `.m3u8` URL in the clear, no
  token or obfuscation on either hop. Every segment it lists, though, is a
  genuine PNG with the real MPEG-TS payload steganographically hidden in
  its pixel data, unwrapped client-side before hls.js ever sees it — a
  plain HLS client (ffmpeg, this relay, anything conforming) just fetches
  an image. Decoding it is simple (plain JS, no WASM), but there is nowhere
  to run that decode step once per segment on an ongoing live stream under
  this scraper's "return a URL" contract — it would need a decoding relay
  in front of the CDN, which is outside what this repository can provide.

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

The channel list and the live-events rail refresh independently once
imported into stremio-tv (twice daily and hourly by default), each on its
own user-settable interval -- see "Config and tasks are optional" in
AGENTS.md for how that's declared.

## [`scrapers/zlive.mts`](./scrapers/zlive.mts) — zlive.st

~200 24/7 channels. Its catalogue (`GET iptv.zlive.st/channels.json`) is
plain, unauthenticated JSON, but turning a channel's opaque `sources[].key`
into a real stream URL (`POST iptv.zlive.st/resolve`) is gated behind a
genuine AES-GCM crypto envelope, not just obfuscation — cracked by running
the site's own minified bundle in a Node `vm` sandbox with browser globals
stubbed and `crypto.subtle` instrumented to log its real inputs, the same
"run it, don't hand-decode it" approach as AGENTS.md's WASM section, applied
to obfuscated JS instead. Every resolved URL needs `Referer: https://zlive.st/`
plus a browser-like `User-Agent`; see the module docstring for the full
algorithm and for why its `/streams` endpoint (same crypto, a live-sporting-
events feed) is deliberately not scraped here.

## [`scrapers/iptv-org.mts`](./scrapers/iptv-org.mts) — iptv-org

iptv-org's curated, deduplicated JSON (channels, streams, feeds, logos,
countries, a blocklist). This is the **default scraper of the
[live-tv](https://github.com/gauravsuman007/live-tv) app**: a fresh data
volume fetches `dist/iptv-org.mjs` from here on first start, and later
updates arrive through the normal "Check for updates" (bump its `version`).
It is also a good worked example, alongside `ntvst.mts`, for a source that
already publishes clean JSON rather than one needing reverse-engineering; its
header explains its `iptv:` id-prefix exception and the rest of its design.

## The contract

Every resolved stream URL is short-lived (minutes, not hours) and often
IP-bound; nothing here should be cached — `build()` is meant to be called
fresh at each catalogue rebuild, and the app re-fetches a channel's stream
at playback time rather than reusing whatever `build()` returned earlier.

## License

GPL-3.0.
