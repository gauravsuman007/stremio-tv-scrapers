# Source tracker

Every live-TV/live-sport source considered for this repository, so the list
can be worked through without re-triaging from scratch. Update this file in
the same commit whenever a source's status changes -- a triage result that
only lives in a chat transcript is lost the next time someone picks this up.
Statuses:

- **implemented** -- shipped as (or as part of) a scraper in `scrapers/`.
- **backend-blocked** -- a specific backend BEHIND an implemented scraper
  resolves to a real stream in research, but can't be delivered under this
  repository's URL-only `ScrapedStream` contract (see AGENTS.md's "What this
  scraper contract cannot do"). Recorded against the parent scraper, not as
  its own row, since the scraper still ships for its other backends.
- **possible** -- a real lead (a stream was actually reached, at least once)
  but needs more work -- an undiscovered resolve step, a gate not yet
  cracked, a result not yet reproduced reliably -- before it's ready to
  build. See each row's note for exactly what's missing.
- **untriaged** -- listed on fmhy.net/video's Live TV / Live Sports sections
  as of 2026-09-28, not yet examined here. Most of these are themselves
  front-ends over a handful of shared backends (dlhd/DaddyLive-family,
  hesgoal-family, streameast-style aggregators) already partly covered by
  `ntvst.mts` or ruled out by `zlive.mts`'s research -- check whether a new
  target actually resolves to one of those before assuming it needs its own
  scraper.
- **rejected** -- examined and ruled out; the reason is recorded so nobody
  retries it blindly.

Source: the "Live TV" and "Live Sports" sections of <https://fmhy.net/video>
(surveyed 2026-09-28). The site's separate "Sports Replays" and "IPTV Tools
& Players" sections are out of scope -- those are on-demand archives and
client apps, not live sources this repository's `Scraper.build()` contract
covers.

Totals: implemented 2 (one with a blocked backend), possible 0, untriaged
~70, rejected 1.

## Implemented (2)

| Site | Note |
|---|---|
| [ntv.st](https://ntv.st/) (+ mirrors `ntvs.cx`, `ntvx.link`) | `scrapers/ntvst.mts`. ~10.4k channels across three unrelated backends: `cdnlive` (~4%, per-request randomised-variable JS assembly) and `hesgoales` (~87%, itself `hesgoal.team`→`wideiptv.top` plain JS literal, plus `epicsports-tv.com`'s `decode.php`, ~50% flaky) are both implemented (~91% of the catalogue). The third, `dlhd` (~9%), is **backend-blocked** -- see below. Also builds a separate live-events rail from ntv.st's own sporting-events feed via its `falcon` mirror. |
| [zlive.st](https://zlive.st/) | `scrapers/zlive.mts`. ~201 24/7 channels. Catalogue is plain JSON; resolving a channel needs a real AES-GCM-encrypted request, cracked by running the site's own bundle in a Node `vm` sandbox (see AGENTS.md's reverse-engineering section) -- not just obfuscation, an actual crypto scheme. Verified end-to-end: all 201 channels currently resolve to a playable `.m3u8`/proxy URL. |

### Backend-blocked (1, within an implemented scraper)

| Backend | Parent scraper | Note |
|---|---|---|
| `dlhd` (ntv.st, ~9% of its catalogue) | `ntvst.mts` | Resolves cleanly over plain HTTP (`dlhd.st`→`daddyliveplayer.st`, no token, no obfuscation) to a bare `.m3u8` URL -- but every segment it lists is a genuine PNG with the real MPEG-TS payload steganographically hidden in pixel data, unwrapped client-side before hls.js ever sees it. That's a per-segment, ongoing decode requirement no `ScrapedStream` (a static URL + two headers) can carry -- it would need a decoding relay in front of the CDN, a host-level capability, not a research gap. See the scraper's own docstring for the full history (this was previously mis-diagnosed as an anti-tamper/domain-lock problem; re-verified 2026-09-28 and correctly re-classified). |

## Untriaged (~70)

Grouped roughly the way fmhy itself groups them. A `→` note means this
session's zlive.st/ntv.st research already suggests (but hasn't confirmed)
what backend a site probably shares.

### Aggregators covering many channels/events at once (highest value if solved)

| Site | Note |
|---|---|
| [TVCL](https://www.tvchannellists.com/) | Channel INDEX/directory, not itself a stream host -- check whether it's worth scraping at all vs. just a discovery page for other sources below. |
| [StreamSports99](https://streamsports99.ru/) (+ mirrors) | |
| [Famelack](https://famelack.com/) | |
| [EasyWebTV](https://zhangboheng.github.io/Easy-Web-TV-M3u8/routes/tv.html) | A static GitHub Pages M3U route list -- likely just re-hosts other sources' URLs; check for a raw `.m3u8`/JSON list before building a live resolver. |
| [IPTV Web](https://iptv-web.app/) | |
| [SportsBite TV](https://sportsbite.org/channels) | |
| [TitanTV](https://titantv.com/) | US/Canada TV listings site -- may be a schedule/EPG source only, not a stream host. |
| [kool.to](https://kool.ws/) | |
| [huhu.to](https://huhu.to/) | |
| [vavoo.to](https://vavoo.to/) | Widely used by third-party Kodi/IPTV addons via its own signed API (`vavoo.to/live/index/{region}` style) -- likely worth checking that API directly rather than the web page. |
| [oha.to](https://oha.to/) | |
| [1TUbe](https://www.1tube.org/live-tv) | |
| [Cinevid](https://cinevid.st/iptv/) | Also has a live-sports schedule page (`/iptv/schedule`); same site as the VOD Cinevid this repo's sibling web-scraper project may already know. |
| [TVNow](https://tvnow.st/) | |
| [Xumo Play](https://play.xumo.com/networks) | Real public API (`valencia-app-mds.xumo.com`), but geo-blocked outside the US -- 302'd to `/geo-block` when tried from this session's network. Needs testing from a US vantage point before ruling in or out. |
| [DamiTV](https://damitv.st/livetv) | 403 on a plain `curl` (Cloudflare) as of 2026-09-28 -- see AGENTS.md's FlareSolverr section before assuming it's a dead end. |
| [90minutes](https://www.90minutes.pro/) | |
| [Pluto](https://pluto.tv/live-tv) | Real, well-documented public API, but needs a session bootstrap call first (`401 BearerTokenRequired` on a bare channel-list request) -- a `possible` lead, not yet pursued past that. |
| [FreeTVGarden](https://freetvgarden.com/) | |
| [Watchott Live](https://iptv.watchott.org/) | |
| [xyzstreams](https://xyzstreams.st/) | |
| [TV Explorer](https://tvexplorer.live/) | |
| [TV247US](https://tvnow247.top/) | |
| [CXtv](https://www.cxtvlive.com/) | |
| [WatchTVs](https://watchtvs.live/) | |
| [Rive IPTV](https://www.rivestream.app/iptv) | Same site as the VOD Rivestream the sibling web-scraper repo already covers -- check whether its IPTV section shares that same scraper API before treating it as a separate source. |
| [Zerostream](https://zerostream.alwaysdata.net/) | |
| [Vegeta TV](http://vegetatv.duckdns.org/) | Plain HTTP (`http://`, no TLS) home-hosted (`duckdns.org`) service -- likely small/personal, low priority. |
| [Global Free TV](https://www.globalfreetv.com/) | |
| [vipotv](https://vipotv.com/) | |
| [SquidTV](https://www.squidtv.net/) | |
| [TVAtlas](https://tvatlas.app/) | |
| [AwardStreams](https://awardstreams.pages.dev/) | |
| [Puffer](https://puffer.stanford.edu/) | A Stanford research project (adaptive-bitrate streaming experiment), not a general aggregator -- likely out of scope entirely. |
| [TV.Jest](https://tv.jest.one/) | |
| [WorldNews24](https://worldnews24.tv/) | |
| [SHOWROOM](https://showroom-live.com/) | Japanese idol/talent livestreaming platform -- different content category than the rest of this list; confirm it's actually free-to-scrape before spending time on it. |
| [Koryo TV](https://koryo.tv/) | |
| [KCNA](https://kcnawatch.us/korea-central-tv-livestream) | North Korean state TV livestream -- niche but a single fixed channel, likely a quick standalone scraper if wanted. |

### Sport-specific aggregators and mirrors

| Site | Note |
|---|---|
| [TimStreams](https://timst.cfd/) | |
| [Streamed](https://streamed.pk/) (+ mirrors `streamed.st`, `strmd.link`) | |
| [StreamCorner](https://streamcorner.st/) (+ mirrors) | |
| [PPV.ST](https://ppv.st/) (+ many TLD mirrors) | |
| [SportsindX](https://sportsindx.st/) | |
| [WatchSports](https://watchsports.st/) (+ `.su`) | |
| [Strumyk](https://strumyk.pk/) | |
| [Strims24](https://strims24.pl/) | |
| [StreamEast](https://streameast.ga/) (+ many TLD mirrors) | One of the most-mirrored names on the list -- worth checking whether all the TLD variants share one backend before triaging each separately. |
| [StreamFree](https://streamfree.top/) | |
| [RoxieStreams](https://roxiestreams.su/) | |
| [BINTV](https://www.bintv.cc/) (+ `cosectv.com`) | |
| [Watch Footy](https://watchfooty.st/) | |
| [LiveTV](https://livetv.sx/enx/) | Long-running, well-known aggregator; likely worth an early look given its longevity. |
| [DaddyLiveHD](https://daddylive.mov/) (+ `.app`, `.li`) | Almost certainly the same `dlhd`/DaddyLive-family backend `ntvst.mts` already found blocked (PNG-steganography segments) -- confirm before spending research time, this is very likely a duplicate of an already-solved (and already-blocked) backend. |
| [Reedstreams](https://reedstreams.to/) (+ mirrors; also listed as "Reedsports") | |
| [Futbol-X](https://www.futbol-x.xyz/) | |
| [Sportsurge](https://v2.sportsurge.net/) (+ `ww1.sportsurge.st`) | |
| [Matchora](https://matchora.to/) | |
| [TotalSportek](https://total-sportekk.st/) | |
| [Score808](https://score808hd.tv/) | |
| [Tap4Sport](https://tap4sport.st/) (+ mirrors) | |
| [CMVTV](https://cmvlinks.lovable.app/) | |
| [Fantastic Soda](https://fantasticsoda.com/) | |
| [FSL](https://freestreams-live1h.pk/) | |
| [Streami](https://streamic.st/) | |
| [SportOnTV](https://sportontv.click/) | |
| [FalconStreams](https://falconstreams.app/) | |
| [VenueVault](https://venuevault.live/) | |
| [CricHD](https://crichd.at/) | |
| [TheTVApp](https://thetvapp.plus/) | |
| [MainPortal66](https://mainportal66.com/) | |
| [FCTV33](https://www.fctv33hd.co/) | |
| [VIP Box Sports](https://vipleague.me/home) (+ mirrors) | |
| [FawaNews](http://www.fawanews.sc/) | Plain HTTP (no TLS). |
| [Baked.live](https://baked.live/) | |
| [Guide TV](https://guidetv.live/) | |
| [NBAMonster](https://nbamonster.com/) | Basketball-specific. |
| [OnHockey](https://onhockey.tv/) | Hockey-specific. |
| [Pitsport](https://pitsport.st/) | Motorsport-specific. |
| [OvertakeFans](https://overtakefans.com/) | Motorsport-specific. |
| [F1 Live](https://flive.dpdns.org/) | F1-specific. |
| [NontonGP](https://esp32.nontonx.com/) | MotoGP-specific. |
| [r/rugbystreams](https://www.reddit.com/r/rugbystreams/) | A subreddit, not a site -- would need per-post link scraping, a very different shape of scraper than everything else here. |
| [Tiz-Cycling](https://tiz-cycling.tv/) | Cycling-specific. |
| [Rugby24](https://rugby24.net/) | Rugby-specific. |
| [Sportarr](https://sportarr.net/) | Describes itself as a *arr-style automation tool (per its GitHub link alongside it), not a stream host directly -- likely a client for other sources rather than a source itself. |

## Rejected (1)

| Site | Reason |
|---|---|
| [Live24](https://livelive24.com/) | Its own "API" link points straight at `livelive24.com/test/ntv/ntv.json` -- a reskin serving ntv.st's own data, not an independent source. `ntvst.mts` already covers the underlying catalogue (and separately uses this same site as its `falcon`-mirror event-resolution backend for `dlhd`-family events, which is unrelated to its 24/7-channel reskin). |
