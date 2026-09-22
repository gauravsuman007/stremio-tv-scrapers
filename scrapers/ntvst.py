"""ntv.st -- 24/7 live-TV channels, not the tube-site catalogue this repo
otherwise scrapes.

Every "video" this plugin returns is a live channel, so there is no fixed
catalogue to search by title match the way the other plugins do -- `search()`
just forwards the query to the site's own fuzzy channel search
(``/api/get-channels?search=``), which is also how the site's own UI searches
its ~10.4k channels. There is no separate "list every channel" step in the
`DirectScraper` contract; a caller gets there by searching for each channel
name it cares about, same as any other plugin here. `browse_channels()`
below is the exception -- see its own docstring.

**The site multiplexes three completely different backend "servers" behind
one channel list**, named in the JSON as ``cdnlive``, ``hesgoales`` and
``dlhd``, in roughly that order of catalogue share (~4% / ~87% / ~9% of
~10.4k channels, sampled 2026-09). And ``hesgoales`` is itself not one
implementation -- see below. Three of the four resulting backends are
handled here:

- ``cdnlive`` channels carry their own ``channel_url`` straight in the list
  response, pointing at ``cdnlivetv.tv``'s player page. That page's HTML is
  regenerated per-request with **randomised variable names** wrapping a fixed
  shape: ten-ish ``var <random>='<base64url fragment>';`` assignments, a
  ``function <random>(s){...atob...}`` decoder, and one assembly line
  ``var <random>=<decoder>(<fragA>)+<decoder>(<fragB>)+...;`` whose *value* --
  not its name -- is the live ``.m3u8`` URL (with a short-lived ``?token=``)
  fed to the page's player. `_extract_cdnlive_stream_url` reads the assembly
  line to learn which fragment names to decode and in what order, rather
  than matching any fixed identifier, since the identifiers themselves
  change every fetch.
- ``hesgoales`` channels -- the largest backend by catalogue share -- fan out
  through at least two unrelated sites, split roughly 25% / 75%:

  - ``hesgoal.team/ntvtvplayer.html?id=<slug>`` is itself a dead end: it
    renders only an empty ``<iframe>`` whose `src` is set by inline JS to
    ``https://wideiptv.top/player/<slug>``, after running the id through
    ``id.trim().replace(/[\\/\\.\\?&=]/g, '')`` (replicated in
    `_clean_hesgoal_slug`). `resolve()` skips hesgoal.team entirely and goes
    straight to wideiptv.top with the cleaned slug, whose player page hands
    back the stream URL **in the clear** -- a plain
    ``streamUrl: "https:\\/\\/<cdn>/<slug>/index.m3u8?token=..."`` JS
    literal, no obfuscation or per-request renamed variables, unlike
    ``cdnlive`` above. Navigating a real browser to wideiptv.top also
    triggers an unrelated ad redirect (a "MR.BANANA DANCE" pop-under, seen
    while researching this plugin) -- harmless for `self._get`, which never
    executes page JavaScript, but worth knowing if you're re-verifying this
    by hand.
  - ``epicsports-tv.com/eu.html?id=<id>`` (~75% of this bucket -- the
    majority of the *entire* catalogue) polls its own ``/decode.php`` for a
    ``{token, code}`` pair used to build a chunked ``video/webm`` URL
    (``uv.dreamstream.cc/<token>/<code>/<id>/webm``, reissued roughly every
    180s per the page's own ``extra`` field). Two things about `decode.php`
    are not obvious from the page's own JS:

    1. It takes **no query string of its own** -- the channel id it needs
       is read from the caller's ``Referer`` header
       (``https://epicsports-tv.com/eu.html?id=<id>``), not from a param on
       the `decode.php` request itself. A request with the right Referer but
       no query string on `decode.php` is what the site's own page actually
       sends.
    2. It is genuinely flaky, succeeding roughly half the time in testing --
       ``{"error":"Failed to extract number","extracted":"??8?88??",
       "processed_image":null}`` on a plain miss, which reads like a
       transient server-side extraction step rather than a client-side
       challenge. The genuine page's own JS (`scheduleRetry` in `eu.html`)
       just retries on exactly this error, and `_resolve_epicsports` does
       the same -- see `_EPICSPORTS_DECODE_ATTEMPTS`.

    A `404 Not Found` (``Server: LameUV``/``LameO``) from `uv.dreamstream.cc`
    after a successful decode is not this plugin's bug -- it means that
    particular channel is not currently live; confirmed by loading the same
    channel in a real browser and watching it fail identically there too.

- ``dlhd`` channels resolve (via ``/channel/<server>/<id>``, itself reached
  through a signed, one-time ``/embed?t=...`` hop) to an iframe pointing at
  ``dlhd.st``/``dlive.sx`` -- a distinct third-party streaming service (also
  known as DaddyLive) with its own chain: a ~600KB obfuscated player page
  that itself iframes a *second* player at ``assetrage.net``, which carries
  the real config in a ``window._econfig`` blob. That blob is not simple
  base64 (a double-``atob`` on it yields binary noise, not JSON or a URL) --
  it is consumed by an ~90KB `javascript-obfuscator`-style bundle
  (`assets/stream.js`) whose decode routine was not recovered statically.
  Worse, `assetrage.net` additionally domain-locks: loading it from anywhere
  other than a real, currently-trusted parent chain (confirmed by embedding
  it from a plain iframe on an untrusted origin) answers "NOT ALLOWED / This
  stream is domain protected" instead of the player. Properly solving this
  would mean either recovering `stream.js`'s actual decode algorithm or
  running real browser JavaScript against a trusted embed chain -- this repo
  avoids a headless-browser dependency (see `noodlemagazine.py`'s section of
  the README for the one exception and why it needed one), so `dlhd` is left
  unresolved here.

Put together: of ntv.st's ~10.4k channels, this plugin resolves ``cdnlive``
(~4%), all of ``hesgoales`` (~87%, both the hesgoal.team and epicsports-tv.com
slices), and not ``dlhd`` (~9%) -- roughly **nine in ten channels overall**.
`resolve()` returns `[]` for `dlhd`, logged at debug rather than guessing --
see this repo's AGENTS.md on why a scraper returning nothing must stay
distinguishable from one that raises.

Every resolved URL, from every backend, carries a short-lived token (minutes,
not hours) baked into the URL. Nothing here caches a resolved URL across
calls; `resolve()` is meant to be called fresh at the moment something is
about to play, same contract as every other scraper in this repo.

`ScraperRailDecl()` is a second, unrelated bulk-export layer for ntv.st's
*live events* rail (single sporting fixtures such as "Liverpool FC v.
Manchester United", grouped by category), sourced from
``/api/get-matches?server=<server>&type=both``, not from the channel index
at all. It returns bare, directly-playable `.m3u8` URLs -- but getting there
took two tries, both worth knowing about:

**`kobra` -- the server the homepage tab defaults to -- is a dead end.**
Resolving one of its events is a two-hop chain: `/watch/kobra/<event-id>`
mints a one-time, signed `/embed?t=<token>` link, and that page's
`streamIframe` always pointed at `embed.st/embed/admin/<slug>/<n>` --
regardless of which "sources" the match JSON itself listed
(`admin`/`delta`/`golf`/`hotel`; ntv.st's own routing already collapses
them). That destination turned out to be **the same backend as `dlhd`**
above, just under a different domain -- a large `javascript-obfuscator`
bundle (`strmd.b-cdn.net/js/bundle-jw.js`) with an active anti-tamper
"self-defending" guard: patching `Function` to trace calls made it corrupt
its own execution rather than proceed, confirmed by running it in a sandboxed
Node `vm` context (browser globals stubbed, no real network) rather than
guessing from static analysis alone. Static extraction also showed it
consults `location.href` through a `RegExp` built at runtime, but that branch
was never reached in the sandbox -- something upstream of it silently exits
first, and Node's own device-detection trace (`iPad|iPhone`, `Andr[0O]id`,
etc. -- genuine JW Player environment probes, not obfuscator artifacts) shows
this really is stock JW Player initializing, just never reaching a `setup()`
call with a real source in this environment.

**`falcon` -- a second, disjoint event catalogue on the *same* API, selected
by the site's own "Falcon" server button -- resolves cleanly.** Its events
are almost entirely different fixtures from `kobra`'s (its own categories are
`Sports Event`, `Soccer`, `Snooker`, `E-Soccer`, `E-Basketball` -- not
`kobra`'s `football`/`baseball`/`hockey`/etc.), so this is a trade: covering
events this plugin can actually resolve to a bare URL, rather than the
specific set the homepage happens to default to. A `falcon` event's `/embed`
token resolves to `livelive24.com`, in one of two plain (non-obfuscated)
shapes depending on the event:

- `livelive24.com/dlhd.html?url=<base64>` -- the `url` param is the target
  `.m3u8`, base64-encoded, no further tricks.
- `livelive24.com/test.html?url=<urlencoded>` -- the `url` param is the
  target `.m3u8` already in the clear, just URL-encoded once (as ordinary
  query-string escaping, not a second encoding layer -- `parse_qs` undoes it
  in one step).

Both were confirmed to play as real `#EXTM3U` playlists across the great
majority of a 47-event sample. One upstream CDN seen behind `test.html`
(`live.vivo155.com`) consistently 403'd in testing regardless of Referer --
its `player.787200.com` player page (a third hop past `test.html`) may set
something this plugin doesn't replicate; `resolve()` still returns that URL
rather than silently dropping the event, since every other upstream (
`wafrqa.com`, `yiom1.com`, `cqsycw.com`) played with no extra headers at all.

`ScraperRailDecl()` therefore defaults to `server="falcon"`, not `"kobra"` --
pass `server="kobra"` explicitly if you'd rather have the homepage's exact
default event list back as *unresolved* embed-page URLs than a different,
fully-resolved one. Same short-lived-token caveat as everything else in this
file: nothing here should be cached past the moment it's handed to a player.
"""

import base64
import json
import re
from typing import Iterator
from urllib.parse import parse_qs, urlparse

from loguru import logger

from program.services.directscrapers.base import DirectScraper, DirectSource, DirectVideo


_CHANNEL_INDEX_URL = "https://ntv.st/api/get-channels"

# --- live events (ScraperRailDecl) ------------------------------------------

_MATCH_INDEX_URL = "https://ntv.st/api/get-matches"
#: `falcon`, not `kobra` (the homepage tab's own default) -- see the module
#: docstring for why: `kobra`'s events all resolve to the same unsolved
#: `dlhd`-family backend, while `falcon` resolves to plain `.m3u8` URLs.
_DEFAULT_MATCH_SERVER = "falcon"
_EMBED_TOKEN_RE = re.compile(r"embed\?t=[^\"'&]+")
_STREAM_IFRAME_SRC_RE = re.compile(r'id="streamIframe"[\s\S]{0,80}?src="([^"]+)"')


def _extract_livelive24_stream_url(embed_url: str) -> str | None:
    """The bare `.m3u8` URL behind a `livelive24.com` embed link, or `None`
    if `embed_url` isn't one of the two known livelive24.com shapes.

    - `/dlhd.html?url=<base64>` -- `url` is the target base64-encoded.
    - `/test.html?url=<urlencoded>` -- `url` is the target already in the
      clear; `parse_qs` (used to read it) undoes the ordinary query-string
      escaping in one step, so no second decode is needed or correct here.
    """

    parsed = urlparse(embed_url)
    if parsed.netloc != "livelive24.com":
        return None

    raw = parse_qs(parsed.query).get("url", [None])[0]
    if not raw:
        return None

    if parsed.path == "/dlhd.html":
        padded = raw + "=" * (-len(raw) % 4)
        try:
            return base64.b64decode(padded).decode("utf-8")
        except Exception:
            return None

    if parsed.path == "/test.html":
        return raw

    return None


# --- cdnlive ---------------------------------------------------------------

_FRAGMENT_ASSIGN_RE = re.compile(r"var (\w+)='([^']*)';")
#: The assembly line the player HTML uses to build its live URL: some
#: variable set to a chain of ``<decoderName>(<fragmentName>)`` calls. The
#: decoder's own name is random too, so it is not matched by name here --
#: only the shape (a call taking one bare identifier) matters.
_ASSEMBLY_RE = re.compile(r"var \w+=((?:\w+\(\w+\)\+?)+);")
_CALL_RE = re.compile(r"\w+\((\w+)\)")


def _b64url_decode(fragment: str) -> str:
    """Undo cdnlivetv.tv's base64url-ish encoding of each URL fragment.

    Padding is added back (the site's own decoder strips it, same as a
    standard JWT/base64url payload), and a decode failure yields "" rather
    than raising -- one bad fragment should not take down the whole scraper.
    """

    padded = fragment.replace("-", "+").replace("_", "/")
    padded += "=" * (-len(padded) % 4)
    try:
        return base64.b64decode(padded).decode("utf-8")
    except Exception:
        return ""


def _extract_cdnlive_stream_url(page: str) -> str | None:
    """The live ``.m3u8`` URL hidden in a cdnlivetv.tv player page.

    See the module docstring -- this reads the *shape* of the assembly line
    (which fragment-decoder calls, in which order) rather than any fixed
    variable name, since every name in the page is randomised per request.
    """

    assembly = _ASSEMBLY_RE.search(page)
    if not assembly:
        return None
    fragment_names = _CALL_RE.findall(assembly.group(1))
    if not fragment_names:
        return None

    fragments = dict(_FRAGMENT_ASSIGN_RE.findall(page))
    try:
        parts = [_b64url_decode(fragments[name]) for name in fragment_names]
    except KeyError:
        return None
    if not all(parts):
        return None

    url = "".join(parts)
    return url if url.startswith("http") else None


# --- hesgoales / hesgoal.team -----------------------------------------------

#: Both hesgoal.team and epicsports-tv.com carry their channel's id as
#: `?id=<...>` on the `channel_url` ntv.st's index hands back -- shared
#: across both resolvers below.
_ID_PARAM_RE = re.compile(r"[?&]id=([^&]+)")
#: The exact character class hesgoal.team's own inline JS strips from the
#: `id` query parameter before handing it to wideiptv.top. Replicated rather
#: than trusted verbatim, since a raw id could otherwise carry a stray query
#: separator into the wideiptv.top request.
_HESGOAL_UNSAFE_SLUG_CHARS_RE = re.compile(r"[/\\.?&=]")
_HESGOAL_STREAM_URL_RE = re.compile(r'streamUrl["\']?\s*:\s*"([^"]+)"')


def _clean_hesgoal_slug(raw_id: str) -> str:
    return _HESGOAL_UNSAFE_SLUG_CHARS_RE.sub("", raw_id.strip()) or "SPT1"


def _extract_hesgoal_stream_url(page: str) -> str | None:
    """The live ``.m3u8`` URL out of a wideiptv.top player page.

    Unlike cdnlive, this is a plain JS string literal -- the only work is
    undoing its one escape sequence (``\\/`` for ``/``).
    """

    match = _HESGOAL_STREAM_URL_RE.search(page)
    if not match:
        return None
    url = match.group(1).replace("\\/", "/")
    return url if url.startswith("http") else None


# --- hesgoales / epicsports-tv.com ------------------------------------------

_EPICSPORTS_DECODE_URL = "https://epicsports-tv.com/decode.php"
_EPICSPORTS_STREAM_BASE = "https://uv.dreamstream.cc"
#: `decode.php` genuinely fails to extract its own server-side number on
#: roughly half of all requests -- not something this plugin can avoid, and
#: not different from what the site's own player does (it retries on exactly
#: this error too). Retrying a handful of times is the intended use of this
#: endpoint, not a workaround for a bug.
_EPICSPORTS_DECODE_ATTEMPTS = 8


def _decode_epicsports(get, channel_id: str) -> tuple[str, str] | None:
    """The `{token, code}` pair `decode.php` hands out for one channel.

    `get` is `self._get` (injected so this stays a plain function, testable
    without a `DirectScraper` instance). `decode.php` takes no query string
    of its own -- see the module docstring -- the channel id travels only in
    `Referer`.
    """

    for _ in range(_EPICSPORTS_DECODE_ATTEMPTS):
        response = get(
            _EPICSPORTS_DECODE_URL,
            headers={
                "Accept": "application/json",
                "Referer": f"https://epicsports-tv.com/eu.html?id={channel_id}",
            },
        )
        try:
            data = json.loads(response.text)
        except ValueError:
            continue
        parsed = data.get("parsed_data") or {}
        if parsed.get("status") == "OK" and parsed.get("token") and parsed.get("code"):
            return parsed["token"], parsed["code"]

    return None


class NtvStScraper(DirectScraper):
    key = "ntvst"
    name = "NTVSTREAM"
    base_url = "https://ntv.st"

    def search(self, query: str, limit: int = 20) -> list[DirectVideo]:
        response = self._get(
            _CHANNEL_INDEX_URL,
            params={"search": query, "limit": limit, "offset": 0},
        )
        data = response.json()
        if not data.get("success"):
            return []

        videos: list[DirectVideo] = []
        for channel in data.get("channels", [])[:limit]:
            video_id = _video_id_for(channel)
            if video_id is None:
                continue

            server = channel.get("server") or ""
            channel_id = channel.get("channel_id") or ""
            videos.append(
                DirectVideo(
                    site=self.key,
                    video_id=video_id,
                    title=channel.get("channel_name") or "Untitled",
                    page_url=f"{self.base_url}/channel/{server}/{channel_id}",
                    thumbnail=channel.get("channel_image") or None,
                    duration=None,  # Live channels have no fixed runtime.
                    views=channel.get("viewers") or None,
                )
            )

        return videos

    def resolve(self, video_id: str) -> list[DirectSource]:
        if video_id.startswith("hesgoal:"):
            return self._resolve_hesgoal(video_id[len("hesgoal:"):])
        if video_id.startswith("epicsports:"):
            return self._resolve_epicsports(video_id[len("epicsports:"):])
        if video_id.startswith("http"):
            return self._resolve_cdnlive(video_id)

        logger.debug(f"{self.key}: no resolver yet for id {video_id!r}")
        return []

    def _resolve_cdnlive(self, channel_url: str) -> list[DirectSource]:
        response = self._get(channel_url)
        stream_url = _extract_cdnlive_stream_url(response.text)
        if not stream_url:
            logger.debug(f"{self.key}: could not extract cdnlive stream URL from {channel_url}")
            return []

        return [
            DirectSource(
                url=stream_url,
                label="Live",
                mime_type="application/vnd.apple.mpegurl",
                # The token in `stream_url` is short-lived and IP-bound in
                # practice, so it is fetched fresh on every resolve() call
                # rather than cached -- same as every other scraper here.
                headers={"Referer": "https://cdnlivetv.tv/"},
            )
        ]

    def _resolve_hesgoal(self, slug: str) -> list[DirectSource]:
        response = self._get(
            f"https://wideiptv.top/player/{slug}",
            headers={"Referer": "https://hesgoal.team/"},
        )
        stream_url = _extract_hesgoal_stream_url(response.text)
        if not stream_url:
            logger.debug(f"{self.key}: could not extract hesgoal stream URL for {slug}")
            return []

        return [
            DirectSource(
                url=stream_url,
                label="Live",
                mime_type="application/vnd.apple.mpegurl",
                headers={"Referer": "https://wideiptv.top/"},
            )
        ]

    def _resolve_epicsports(self, channel_id: str) -> list[DirectSource]:
        pair = _decode_epicsports(self._get, channel_id)
        if pair is None:
            logger.debug(
                f"{self.key}: decode.php would not extract a token for"
                f" epicsports channel {channel_id} after"
                f" {_EPICSPORTS_DECODE_ATTEMPTS} attempts"
            )
            return []
        token, code = pair

        # Whether this URL is actually live is not checked here -- same as
        # every other backend in this file, `resolve()` hands back the URL
        # it built and leaves playback to the caller. A dead channel here
        # surfaces as a 404 from uv.dreamstream.cc at play time, not as an
        # empty result from `resolve()`.
        stream_url = f"{_EPICSPORTS_STREAM_BASE}/{token}/{code}/{channel_id}/webm"

        return [
            DirectSource(
                url=stream_url,
                label="Live",
                mime_type="video/webm",
                headers={"Referer": "https://epicsports-tv.com/"},
            )
        ]

    def browse_channels(self) -> Iterator[dict]:
        """One row per channel in the site's full catalogue: name + resolved
        stream URL.

        Not part of the `search`/`resolve` contract -- nothing in
        riven-tpdb calls this. It exists for pulling the whole catalogue out
        of the site directly (e.g. from a one-off script running inside the
        container), separately from the app's own search flow.

        Yields incrementally rather than building one big list: the
        catalogue is ~10.4k channels and every `cdnlive`/`hesgoales` one
        costs its own HTTP round-trip to resolve, so a caller can start
        consuming and persisting rows before the whole run finishes.

        `video_url` is `None` for `dlhd` channels (unresolved -- see the
        module docstring) and also for any single channel whose resolve
        happens to fail (a dead channel, a transient error); either way the
        row is still yielded so the channel isn't silently dropped from the
        export. Every `video_url` that does come back is a snapshot, not
        something safe to store and reuse later -- see the module docstring
        on token lifetimes.
        """

        # The API caps `limit` at 100 server-side regardless of what is
        # requested, so paging by 100 is the fastest this endpoint allows.
        page_size = 100
        offset = 0

        while True:
            response = self._get(
                _CHANNEL_INDEX_URL, params={"limit": page_size, "offset": offset}
            )
            data = response.json()
            if not data.get("success"):
                break

            channels = data.get("channels", [])
            if not channels:
                break

            for channel in channels:
                name = channel.get("channel_name") or "Untitled"
                video_id = _video_id_for(channel)

                video_url = None
                if video_id is not None:
                    try:
                        sources = self.resolve(video_id)
                    except Exception as exc:
                        logger.debug(f"{self.key}: browse failed to resolve {name!r}: {exc}")
                    else:
                        if sources:
                            video_url = sources[0].url

                yield {"channel_name": name, "video_url": video_url}

            if not data.get("has_more"):
                break
            offset += page_size

    def ScraperRailDecl(self, server: str = _DEFAULT_MATCH_SERVER) -> list[dict]:
        """ntv.st's live-events rail, grouped by category: one item per
        category, each holding that category's live events with their
        resolved, bare `.m3u8` video URL(s).

        Defaults to the `falcon` server/catalogue, not `kobra` (the homepage
        tab's own default) -- see the module docstring for why: `kobra`'s
        events all dead-end at the same unsolved backend as `dlhd`, while
        `falcon`'s resolve to plain, directly-playable URLs. Not part of the
        `search`/`resolve` contract -- nothing in riven-tpdb calls this, same
        as `browse_channels()`.

        Returns:
            ``[{"category": "Soccer", "events": [{"event_name": "...",
            "video_urls": ["https://pull.wafrqa.com/live/.../playlist.m3u8"]},
            ...]}, ...]`` in the order ntv.st's own API lists categories. A
            category with no currently-live events is omitted rather than
            included empty.
        """

        response = self._get(
            _MATCH_INDEX_URL, params={"server": server, "type": "both"}
        )
        data = response.json()
        if not data.get("success"):
            return []

        events_by_category: dict[str, list[dict]] = {}
        for match in data.get("live", []):
            category = match.get("category") or "uncategorized"
            events_by_category.setdefault(category, []).append(match)

        rail: list[dict] = []
        for category in data.get("categories", []):
            matches = events_by_category.get(category)
            if not matches:
                continue

            events = []
            for match in matches:
                name = match.get("title") or "Untitled"
                try:
                    video_urls = self._resolve_match_stream_urls(server, match)
                except Exception as exc:
                    logger.debug(f"{self.key}: rail failed to resolve {name!r}: {exc}")
                    video_urls = []
                events.append({"event_name": name, "video_urls": video_urls})

            rail.append({"category": category, "events": events})

        return rail

    def _resolve_match_stream_urls(self, server: str, match: dict) -> list[str]:
        """The bare stream URL(s) for one live event.

        In testing this was always a single URL regardless of how many
        entries the match's own `sources` list carried -- ntv.st's
        `/watch/` page already picks one before minting the embed token, not
        something this plugin controls or needs to (see the module
        docstring) -- but this returns a list rather than `str | None` in
        case a future deployment exposes more than one.
        """

        match_id = match.get("id")
        if not match_id:
            return []

        watch_response = self._get(f"{self.base_url}/watch/{server}/{match_id}")
        token_match = _EMBED_TOKEN_RE.search(watch_response.text)
        if not token_match:
            logger.debug(f"{self.key}: no embed token on /watch page for {match_id}")
            return []

        embed_response = self._get(f"{self.base_url}/{token_match.group(0)}")
        src_match = _STREAM_IFRAME_SRC_RE.search(embed_response.text)
        if not src_match:
            logger.debug(f"{self.key}: no streamIframe src in embed page for {match_id}")
            return []

        stream_url = _extract_livelive24_stream_url(src_match.group(1))
        if stream_url:
            return [stream_url]

        # Not a livelive24.com destination this plugin knows how to unwrap
        # (most often `embed.st`, the same unsolved backend as `dlhd` --
        # see the module docstring). Hand back the embed page itself rather
        # than an empty list: it is not a bare media URL, but it is still
        # something a browser/WebView could load, and the caller can tell
        # the two cases apart by checking whether the URL is playable
        # directly.
        logger.debug(
            f"{self.key}: {match_id} resolved to an unrecognised embed destination"
            f" {src_match.group(1)!r}; returning it unresolved"
        )
        return [src_match.group(1)]


def _video_id_for(channel: dict) -> str | None:
    """The opaque id this plugin hands back to itself via `resolve()`.

    Each backend gets its own shape rather than one generic `server:id`
    scheme, because `cdnlive` and `hesgoales` each need different data to
    resolve later (a full URL vs. a bare slug) and encoding that need in the
    id avoids a second lookup against the channel index inside `resolve()`.
    `dlhd` has no resolver yet, so it gets no id -- `None` tells callers to
    skip the channel rather than carry an id nothing can use.
    """

    server = channel.get("server") or ""

    if server == "cdnlive":
        channel_url = channel.get("channel_url") or ""
        return channel_url or None

    if server == "hesgoales":
        channel_url = channel.get("channel_url") or ""
        host = urlparse(channel_url).netloc

        # The `hesgoales` bucket is not one implementation -- see the module
        # docstring. Route each known host to its own resolver; anything
        # else (the small remainder on hesgoaler.com etc.) is left
        # unresolved rather than guessed at.
        if host == "hesgoal.team":
            match = _ID_PARAM_RE.search(channel_url)
            if not match:
                return None
            return "hesgoal:" + _clean_hesgoal_slug(match.group(1))

        if host == "epicsports-tv.com":
            match = _ID_PARAM_RE.search(channel_url)
            if not match:
                return None
            return "epicsports:" + match.group(1).strip()

        return None

    return None
