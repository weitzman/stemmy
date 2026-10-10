#!/usr/bin/env bash
# Add a song to the Split Open player from an archive.org FLAC URL.
#
#   scripts/add-song.sh <archive.org flac url> [--title "Song"] [--set "Set II"] [--band "Phish"]
#
# The song's "source" in songs.json is the archive.org item page the FLAC
# came from, https://archive.org/details/<item>.
#
# The band defaults to the item's creator; its channel layout (who plays what)
# must exist in bands.json under the slugified band name.
#
# Steps: download FLAC -> BS-Roformer-SW separation -> encode five Opus stems
# (piano+other merged into keys) -> add/replace the entry in songs.json.
# Each step is skipped when its output already exists, so re-running is cheap.
#
# Stems are Opus in an Ogg container (.opus). Safari used to accept Opus only
# inside CAF, so a 10 s clip was encoded both ways and fed to decodeAudioData
# on 2026-10-06: Ogg Opus decoded in Safari 27, Firefox 157, Chrome 154, and
# Chromium 152; CAF Opus decoded only in Safari. ffmpeg's CAF muxer cannot
# write Opus anyway (afconvert can). The player then loaded and played the
# Ogg Opus stems on iPhone Safari over the LAN. AAC in M4A decoded everywhere
# too, but Safari padded it to 10.008 s where Opus came back exactly 10.000 s.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="BS-Roformer-SW.ckpt"
BITRATE="128k"

url="${1:-}"; shift || true
[[ -n "$url" ]] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

title=""; set_name=""; band=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)  title="$2";       shift 2 ;;
    --set)    set_name="$2";    shift 2 ;;
    --band)   band="$2";        shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

for cmd in curl ffmpeg audio-separator python3; do
  command -v "$cmd" >/dev/null || { echo "missing: $cmd" >&2; exit 1; }
done

# URL forms: https://<host>/0/items/<item>/<file>  or  https://archive.org/download/<item>/<file>
item="$(python3 - "$url" <<'PY'
import re, sys
m = re.search(r'/(?:items|download)/([^/]+)/', sys.argv[1])
print(m.group(1) if m else '')
PY
)"
fname="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1].rsplit("/",1)[-1]))' "$url")"
[[ -n "$item" && "$fname" == *.flac ]] || { echo "can't parse item/filename from url: $url" >&2; exit 1; }

src_dir="$ROOT/audio/src/$item"
sep_dir="$ROOT/audio/stems/$item"
src="$src_dir/$fname"
base="${fname%.flac}"

# --- 1. download --------------------------------------------------------
mkdir -p "$src_dir"
if [[ -s "$src" ]]; then
  echo "[1/4] already downloaded: $src"
else
  echo "[1/4] downloading $fname"
  curl -fL --progress-bar -o "$src.part" "$url" && mv "$src.part" "$src"
fi

# --- 2. metadata --------------------------------------------------------
echo "[2/4] fetching metadata for $item"
curl -fsL "https://archive.org/metadata/$item" -o "$src_dir/metadata.json"
meta="$(python3 - "$src_dir/metadata.json" "$fname" "$title" "$band" "$ROOT/bands.json" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1])); m = d.get('metadata', {}); fname, title, band = sys.argv[2], sys.argv[3], sys.argv[4]
f = next((f for f in d.get('files', []) if f.get('name') == fname), {})
if not title:
    title = f.get('title') or re.sub(r'^\s*(d\d+)?t?\d+[\s._-]+', '', fname[:-5]).strip() or fname[:-5]
title = re.sub(r'(\s*(->|>|\*))+\s*$', '', title).strip()  # drop trailing segue / footnote markers
band = band or m.get('creator') or 'Phish'
if isinstance(band, list): band = band[0]
band_id = re.sub(r'[^a-z0-9]+', '-', band.lower()).strip('-')
if band_id not in json.load(open(sys.argv[5])):
    sys.exit(f"band '{band}' ({band_id}) has no channel layout in bands.json; add one or pass --band")
date = (m.get('date') or '')[:10]
venue = m.get('venue') or ''; city = m.get('coverage') or ''
t = m.get('title') or ''
if not (venue and city):
    mm = re.match(r'.*?\d{4}-\d{2}-\d{2}\s*-\s*(.+?)\s*-\s*(.+)$', t) or re.match(r'.*Live at (.+?), (.+?) on \d{4}', t)
    if mm: venue, city = venue or mm.group(1), city or mm.group(2)
venue = re.sub(r'^the\s+', '', venue, flags=re.I)
print(json.dumps({'title': title, 'date': date, 'venue': venue, 'city': city.rstrip('.'), 'band': band_id}))
PY
)"
title="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["title"])' "$meta")"
date="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["date"])' "$meta")"
slug="$(python3 -c 'import re,sys; print(re.sub(r"[^a-z0-9]+","-",re.sub(r"['\''’]","",sys.argv[1].lower())).strip("-"))' "$title")"
id="${date}-${slug}"
out="$ROOT/audio/songs/$id"
echo "      $title — $date  ->  audio/songs/$id"

# --- 3. separate --------------------------------------------------------
stem() { printf '%s/%s_(%s)_%s.wav' "$sep_dir" "$base" "$1" "${MODEL%.ckpt}"; }
if [[ -s "$(stem bass)" && -s "$(stem other)" ]]; then
  echo "[3/4] already separated: $sep_dir"
else
  echo "[3/4] separating with $MODEL (several minutes on CPU)"
  mkdir -p "$sep_dir"
  audio-separator -m "$MODEL" --output_dir "$sep_dir" --output_format WAV "$src"
fi

# --- 4. encode + register -----------------------------------------------
encoded=1
for s in drums bass vocals guitar keys; do [[ -s "$out/$s.opus" ]] || encoded=0; done
if [[ $encoded == 1 ]]; then
  echo "[4/4] already encoded: $out"
else
  echo "[4/4] encoding stems"
  mkdir -p "$out"
  for s in drums bass vocals guitar; do
    ffmpeg -hide_banner -loglevel error -y -i "$(stem $s)" -c:a libopus -b:a "$BITRATE" "$out/$s.opus"
  done
  ffmpeg -hide_banner -loglevel error -y -i "$(stem piano)" -i "$(stem other)" \
    -filter_complex "amix=inputs=2:normalize=0" -c:a libopus -b:a "$BITRATE" "$out/keys.opus"
fi

python3 - "$ROOT/songs.json" "$meta" "$id" "$set_name" "https://archive.org/details/$item" <<'PY'
import json, sys
path, meta, id_, set_name, source = sys.argv[1:]
meta = json.loads(meta)
entry = {'id': id_, 'band': meta['band'], 'title': meta['title'], 'date': meta['date'], 'set': set_name,
         'venue': meta['venue'], 'city': meta['city'], 'source': source,
         'dir': f'audio/songs/{id_}/'}
try:
    songs = json.load(open(path))
except FileNotFoundError:
    songs = []
old = next((s for s in songs if s['id'] == id_), None)
if old:
    entry['set'] = set_name or old.get('set', '')
    songs[songs.index(old)] = entry
else:
    songs.append(entry)  # new songs go on the end of the picker
json.dump(songs, open(path, 'w'), indent=2); open(path, 'a').write('\n')
print(f"      {'updated' if old else 'added'} songs.json entry {id_}")
PY

echo "done: open the player and pick \"$title\" (hash #$id)"
