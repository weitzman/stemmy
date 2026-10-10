# Split Open

Our favorite songs, [Split Open](https://weitzman.github.io/splitopen) so we can learn and appreciate.

A stem mixer for live recordings: each band member on a separate
channel with mute, solo, and a fader, playing in sync.

- `index.html`, `app.js`, `styles.css`, `songs.json`, `bands.json` — the player
  (static HTML + Web Audio API, no build step), served from the repo root
- `audio/songs/<id>/` — five Opus stems per song (128 kbps, Ogg container): guitar, bass, keys, drums, vocals
- A song in `songs.json` names its band, whose lineup comes from `bands.json`
  (`who` and `inst` per stem: guitar, bass, keys, drums, vocals). A song can
  override any of those for the night, since lineups change: a `channels`
  map on the song with the stems to change, e.g.
  `"channels": { "keys": { "who": "Page & Medeski" }, "guitar": { "inst": "Guitars" } }`.
  Its `source` is the archive.org item page the recording came from. A
  song with `"hidden": true` stays out of the picker but still plays from a
  direct link.
- `scripts/add-song.sh` — download a FLAC from archive.org, separate it with
  BS-Roformer-SW (`audio-separator`), encode the stems, register the song in
  `songs.json`
- `scripts/social-card.html` — source for `social.png`, the link-preview image.
  Regenerate after editing it with headless Chrome:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --virtual-time-budget=8000 --window-size=1200,630 --screenshot=social.png file://$PWD/scripts/social-card.html`

The URL hash holds the song and, optionally, the mix and the moment, so a
link can reproduce both. The song id comes first; the rest are `&`-separated
`key=value` pairs, all optional:

    #1998-07-26-funky-bitch&solo=keys&mute=vocals&g=guitar:0.8,bass:1.2&t=312

- `solo`, `mute` — comma-separated stem ids: `guitar`, `bass`, `keys`, `drums`, `vocals`
- `g` — fader gains as `stem:value` pairs, 0 to 1.5 (1 is unity)
- `t` — position in seconds; the player seeks there but waits for Play

The player keeps the hash current as you mix and the Copy link button (or `L`)
copies it with the current position.

## Guides

A guide is a listening tour of a song: an ordered list of tips, each a
passage, a mix, and a note. The mix holds for the passage and the band plays
in full between tips; when the playhead reaches a tip its note is shown.

To write one, press **+ New guide** under the song title (or **Copy & edit**
on an open guide to start from a copy of it), play the song, set mute/solo, and press `N` (or
**Tip: Start**) where a passage worth a tip begins. The tip takes that
moment and the mix in force, and runs to the next tip unless given an end.
The list shows one line per tip with edit, play and delete; edit opens that
tip alone, with its start, optional end and description, and a play button
that loops the passage. Start and end are set from the playhead: scrub or
play to the moment, then press Set. Tapping the mix label opens a sheet with
Mute and Solo per player, heard as you choose. Tips can be dragged into another order
by their handle. The list is always saved: the draft is kept in the link as it
changes, so **Share** hands it out and a reload brings it back. The title, author and language are not asked for while writing; they
belong to the step of offering a guide to the library.

Guides are written as plain text:

    title: Mike's entrance
    lang: en
    by: Foo Bar
    url: https://example.com/foo
    0:00 to=0:32 solo=drums | Fish sets up the groove alone.
    0:32 to=1:05 solo=drums,bass pause | Mike enters. Notice he plays behind the beat.
    1:05 to=1:20 mute=vocals | The band without the singing.
    1:05 to=1:20 solo=keys | The same passage, Page alone.

- Header lines are `key: value`: `title`, `lang` (the notes' language code,
  e.g. `en` or `fr`), `by` (the author's name, shown after the guide's
  title) and `url` (a link for the author's name).
- A tip line starts with `m:ss`, then any of `to=m:ss` (where the tip ends;
  without it, at the next tip), `solo=`, `mute=`, `g=` (as in the hash) and
  `pause`, then `|` and the note. A later tip may start before the one
  before it ends, which is how a passage is replayed.
- `pause` stops the music at the tip until the listener presses Continue.

Guides kept in the repo live at `guides/<song id>/<slug>.txt` in the text
form below, listed by slug under the song id in `guides.json`; they appear as
pills under the song and open with `guide=<slug>`.

A guide travels in the link: `#songid&guide=<slug>` for one in the repo, or
`guide=z…`, the deflated text, for one written in the player or by hand. To
make such a link by hand, open the song, then in the browser console:

    await SplitOpen.guideLink(`title: ...
    0:00 solo=drums | ...`)

A dozen tips with a sentence each come to about a kilobyte of link.

Run locally with `python3 scripts/serve.py` (a static server that turns
caching off, so a reload always gets the current files) and open
`http://localhost:8765/`. Any static server from the repo root works too.

The site is served by GitHub Pages from the `gh-pages` branch, which a
workflow refreshes from `main` on every push. Each pull request gets a
preview at `https://weitzman.github.io/splitopen/pr-preview/pr-<number>/`,
linked from a comment on the PR and removed when it closes. Links to the
old `/web/` path redirect to the root.

Source recordings come from the [Live Music Archive](https://archive.org/details/etree)
and are for non-commercial listening only.
