# stremio-tv-scrapers

Live-TV/sports scrapers for [stremio-tv](https://github.com/gauravsuman007):
24/7 channels and live sporting events, scraped straight from a site's own
CDN with no torrent or debrid step. Each file is a standalone `Scraper`
(one `build()` function returning a full catalogue), meant to be dropped
into that app's `src/scrapers/` and registered in `src/scrapers.ts` — see
the header comment of [`scrapers/ntvst.ts`](./scrapers/ntvst.ts)'s sibling
template, `docs/scraper-template.ts` in that repo, for the exact contract.

## [`scrapers/ntvst.ts`](./scrapers/ntvst.ts) — ntv.st

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
npm install --no-save typescript tsx @types/node
npx tsx scrapers/ntvst.ts
```

Prints the resulting channel/rail counts and the first channel. ntv.st
rate-limits its own channel index API fairly aggressively after a few
thousand consecutive requests from one IP — `build()` retries 429s with a
short backoff, but a full run can still take several minutes.

## The contract

Every resolved stream URL is short-lived (minutes, not hours) and often
IP-bound; nothing here should be cached — `build()` is meant to be called
fresh at each catalogue rebuild, and the app re-fetches a channel's stream
at playback time rather than reusing whatever `build()` returned earlier.

## License

GPL-3.0.
