# stremio-tv-scrapers

Direct-scrape plugins for live TV: 24/7 channels and live sporting events,
scraped straight from a site's own CDN with no torrent or debrid step. Same
`DirectScraper` plugin contract as
[riven-tpdb-scrapers](https://github.com/gauravsuman007/riven-tpdb-scrapers)
(`search`/`resolve`, loaded inside a running `riven-tpdb` container), but
scoped to live TV/sports sites rather than tube-site VOD.

## [`scrapers/ntvst.py`](./scrapers/ntvst.py) — ntv.st

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

Also implements `ScraperRailDecl()`, a bulk-export of ntv.st's live sporting
events grouped by category, resolving to bare `.m3u8` URLs. It deliberately
targets ntv.st's `falcon` mirror server rather than `kobra` (the homepage
tab's own default): `kobra`'s events all dead-end at the same unresolved
`dlhd`-family backend, while `falcon` resolves cleanly through
`livelive24.com` (plain base64 or urlencoded `.m3u8` links, no obfuscation) —
a different, though mostly disjoint, event catalogue in exchange for URLs
that actually play.

Read the source comments — every non-obvious step is explained with *why*,
not just what the code does; that context is usually more useful than the
code itself when adapting this to a similar site.

## The contract

Each file is a standalone `DirectScraper` plugin (`search`/`resolve`),
loaded inside a running `riven-tpdb` container — `program.services.directscrapers.base`
comes from that app, not this repo. Deploy by copying the file into the
deployment's `plugins/` folder and clicking "Rescan folder" in
Settings → Plugins. Every resolved URL is short-lived (minutes, not hours);
nothing here should be cached — `resolve()`/`ScraperRailDecl()` are meant to
be called fresh at the moment something is about to play.

## License

GPL-3.0.
