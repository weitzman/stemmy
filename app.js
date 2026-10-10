// Split Open — multi-stem player built on the Web Audio API.
// All stems are decoded up front and started on the same AudioContext clock,
// so they stay sample-locked; mute/solo/fader are just gain changes.
//
// Switching songs is kept cheap three ways: the context runs at the stems'
// native 48 kHz so decoding skips a resample, decoded songs stay in a
// memory-bounded cache, and the other songs are fetched (and, budget
// permitting, decoded) in the background once the current one is ready.

// Fixed stem slots; who plays each one comes from bands.json per song.
const SLOTS = [
  { id: 'guitar', file: 'guitar.opus', color: 'var(--trey)' },
  { id: 'bass',   file: 'bass.opus',   color: 'var(--mike)' },
  { id: 'keys',   file: 'keys.opus',   color: 'var(--page)' },
  { id: 'drums',  file: 'drums.opus',  color: 'var(--fish)' },
  { id: 'vocals', file: 'vocals.opus', color: 'var(--vox)' },
];
let STEMS = SLOTS;
const STEM_FILES = SLOTS.map(s => s.file);

// The stems are Opus, which always decodes at 48 kHz. Matching the context
// rate avoids resampling every stem on decode, which is roughly 3x slower
// than decoding alone.
const STEM_RATE = 48000;
const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: STEM_RATE });
const master = ctx.createGain();
master.connect(ctx.destination);

// iOS Safari gives a tab on the order of 1 GB before killing it, and a single
// 8-minute song decodes to ~920 MB of PCM. It also doesn't report
// deviceMemory. Treat touch devices that don't report memory as constrained:
// no decoded-song cache, no background decoding, one stem decoded at a time,
// and a real page reload on song switch so the old song's buffers are freed
// before the new one is decoded (GC timing is otherwise not ours to control).
const LOW_MEMORY = !navigator.deviceMemory && navigator.maxTouchPoints > 1;

// iOS routes Web Audio through the "ambient" audio session, which obeys the
// ring/silent switch, so the graph runs but nothing comes out of the speaker.
// Media elements use the "playback" session instead. On iOS 17+ we can ask for
// that session directly; on older iOS, keeping a silent <audio> element playing
// alongside the graph has the same effect. The silent element also runs on
// iOS 17+, because the lock-screen and headphone controls (see the media
// session block below) only appear while a media element is playing; Web Audio
// alone never counts as "Now Playing".
if (navigator.audioSession) {
  try { navigator.audioSession.type = 'playback'; } catch (_) { /* unsupported value */ }
}

// 8 kHz 8-bit mono silence; 8 KB per second, so a 10-minute song is ~5 MB.
function silentWavUrl(seconds) {
  const rate = 8000, frames = rate * seconds;
  const buf = new ArrayBuffer(44 + frames);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + frames, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, frames, true);
  new Uint8Array(buf, 44).fill(0x80); // unsigned 8-bit silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// Safari copies this element's currentTime into the Media Session position
// state whenever the element seeks, loops, or pauses, which is what the lock
// screen scrubber shows. So the silent file outlasts the song and the element's
// clock is kept on the song position: it starts at the current offset and
// follows every seek.
let keepalive = null;
let keepaliveSeconds = 0;
function keepaliveStart() {
  if (!keepalive) {
    keepalive = new Audio();
    keepalive.loop = true;
    keepalive.setAttribute('playsinline', '');
    mediaSessionWatchKeepalive(keepalive);
  }
  const seconds = Math.ceil(duration) + 5;
  if (keepaliveSeconds < seconds) {
    if (keepalive.src) URL.revokeObjectURL(keepalive.src);
    keepalive.src = silentWavUrl(seconds);
    keepaliveSeconds = seconds;
  }
  keepalive.currentTime = offset;
  keepalive.play().catch(() => { /* not allowed outside a gesture; harmless */ });
}
function keepaliveStop() {
  if (keepalive) keepalive.pause();
}
function keepaliveSeek(to) {
  if (keepalive && !keepalive.paused) keepalive.currentTime = to;
}

let songs = [];
let bands = {};
let song = null;
let band = null;
let channels = []; // { def, buffer, fader, muteGain, analyser, source?, ui }
let playing = false;
let startedAt = 0;   // ctx.currentTime when playback started
let offset = 0;      // position (s) at which playback started
let duration = 0;
let loadToken = 0;   // guards against a stale load finishing after a song switch

// ---------- loading ----------

async function fetchStem(url, onProgress, priority) {
  const res = await fetch(url, { priority });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(total ? received / total : 0);
  }
  const bytes = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { bytes.set(c, pos); pos += c.length; }
  return bytes.buffer;
}

// Compressed stems, keyed by song id. ~8 MB per stem, so every song fits.
const byteCache = new Map();   // id -> Promise<ArrayBuffer[]>
const bytesReady = new Set();  // ids whose fetch has finished

function fetchSongBytes(s, onProgress, priority = 'high') {
  if (!byteCache.has(s.id)) {
    const p = Promise.all(STEM_FILES.map((file, i) =>
      fetchStem(s.dir + file, onProgress && (f => onProgress(i, f)), priority)
    ));
    p.then(() => bytesReady.add(s.id), () => byteCache.delete(s.id));
    byteCache.set(s.id, p);
  }
  return byteCache.get(s.id);
}

// Decoded stems: ~185 MB per stem for an 8-minute song, so the cache has a
// byte budget of a quarter of device memory, capped at 2 GB. Browsers that
// don't report memory (Safari) are assumed to be small. The song playing now
// is always kept; beyond that, least recently used songs are dropped.
const decodedCache = new Map(); // id -> Promise<AudioBuffer[]>; insertion order = LRU
const decodedBytes = new Map(); // id -> bytes once decoded
const DECODE_BUDGET = LOW_MEMORY ? 0 : Math.min(2048, (navigator.deviceMemory || 2) * 256) * 1024 * 1024;

function bufferBytes(buffers) {
  return buffers.reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0);
}

function cachedBytesTotal() {
  let n = 0;
  for (const v of decodedBytes.values()) n += v;
  return n;
}

function touchDecoded(id) {
  const p = decodedCache.get(id);
  decodedCache.delete(id);
  decodedCache.set(id, p);
}

function evictDecoded(keepId) {
  for (const id of decodedCache.keys()) {
    if (cachedBytesTotal() <= DECODE_BUDGET) return;
    if (id === keepId || (song && id === song.id) || !decodedBytes.has(id)) continue;
    decodedCache.delete(id);
    decodedBytes.delete(id);
  }
}

function decodeSong(s, onProgress, priority) {
  if (decodedCache.has(s.id)) {
    touchDecoded(s.id);
    return decodedCache.get(s.id);
  }
  const p = (async () => {
    const bytes = await fetchSongBytes(s, onProgress, priority);
    // decodeAudioData detaches its input, so decode a copy and keep the bytes.
    // Parallel decoding is faster where there's a thread pool (Chrome), but
    // on a phone five decoders' scratch space at once is what tips it over.
    let buffers;
    if (LOW_MEMORY) {
      buffers = [];
      for (const b of bytes) buffers.push(toMono(await ctx.decodeAudioData(b.slice(0))));
    } else {
      buffers = await Promise.all(bytes.map(b => ctx.decodeAudioData(b.slice(0))));
    }
    decodedBytes.set(s.id, bufferBytes(buffers));
    evictDecoded(s.id);
    return buffers;
  })();
  p.catch(() => { decodedCache.delete(s.id); decodedBytes.delete(s.id); });
  decodedCache.set(s.id, p);
  return p;
}

async function loadAllStems(s) {
  const fill = document.getElementById('loading-fill');
  const label = document.getElementById('loading-label');
  const haveBytes = bytesReady.has(s.id);
  label.textContent = haveBytes ? 'Decoding…' : 'Loading stems…';
  fill.style.width = haveBytes ? '100%' : '0%';
  const progress = new Array(STEM_FILES.length).fill(0);
  const buffers = await decodeSong(s, (i, f) => {
    progress[i] = f;
    const pct = progress.reduce((a, b) => a + b, 0) / progress.length * 100;
    fill.style.width = pct.toFixed(1) + '%';
    if (pct >= 100) label.textContent = 'Decoding…';
  });
  return buffers;
}

// Warm the other songs in the background: fetch bytes for all of them, and
// pre-decode as many as the memory budget allows, nearest in the list first.
let warmToken = 0;
async function warmOtherSongs(current) {
  const token = ++warmToken;
  if (LOW_MEMORY) return;
  if (navigator.connection && navigator.connection.saveData) return;
  const listed = listedSongs();
  const i = listed.findIndex(s => s.id === current.id);
  const order = [];
  for (let d = 1; d < listed.length; d++) {
    order.push(listed[(i + d) % listed.length]);
  }
  for (const s of order) {
    if (token !== warmToken) return;
    try {
      const bytes = await fetchSongBytes(s, null, 'low');
      if (token !== warmToken) return;
      const est = bytes.reduce((n, b) => n + estimateDecodedBytes(b), 0);
      if (cachedBytesTotal() + est <= DECODE_BUDGET) await decodeSong(s, null, 'low');
    } catch (err) {
      console.warn('warm failed', s.id, err);
    }
  }
}

// On constrained devices each stem is folded to mono right after decoding,
// which halves what a song costs to keep around (~920 MB -> ~460 MB for an
// 8-minute song). The phone speaker is mono anyway; headphones lose the
// stereo image of the separated stems, which is a fair trade for not crashing.
function toMono(buf) {
  const n = buf.numberOfChannels;
  if (n === 1) return buf;
  const mono = ctx.createBuffer(1, buf.length, buf.sampleRate);
  const out = mono.getChannelData(0);
  for (let ch = 0; ch < n; ch++) {
    const src = buf.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i] += src[i] / n;
  }
  return mono;
}

// Rough decoded size from the compressed size: 128 kbps stereo Opus decoded
// to Float32 at 48 kHz expands by 24x (48000 * 2 ch * 4 bytes * 8 / 128000).
// Opus is variable bit rate, so a mostly silent stem comes in well under
// 128 kbps and this undershoots for it; the cache itself counts real sizes.
function estimateDecodedBytes(arrayBuffer) {
  return arrayBuffer.byteLength * 24;
}

// ---------- graph ----------

function buildChannel(def, buffer) {
  const fader = ctx.createGain();
  const muteGain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;

  fader.connect(muteGain);
  muteGain.connect(analyser);
  analyser.connect(master);

  return { def, buffer, fader, muteGain, analyser, source: null, mute: false, solo: false };
}

function teardownChannels() {
  clearSoloHint();
  stopSources();
  keepaliveStop();
  for (const c of channels) c.analyser.disconnect();
  channels = [];
  playing = false;
  offset = 0;
  duration = 0;
}

function applyMuteSolo() {
  const anySolo = channels.some(c => c.solo);
  for (const c of channels) {
    const audible = anySolo ? c.solo : !c.mute;
    c.muteGain.gain.setTargetAtTime(audible ? 1 : 0, ctx.currentTime, 0.01);
    c.ui.strip.classList.toggle('inactive', !audible);
    c.ui.mute.classList.toggle('on', c.mute);
    c.ui.solo.classList.toggle('on', c.solo);
  }
  updateHints();
  writeHash();
}

// ---------- URL state ----------
//
// The hash names the song first, so older links still work, then carries the
// mix and the moment as &-separated key=value pairs:
//   #1998-07-26-funky-bitch&solo=keys&mute=vocals&g=guitar:0.8,bass:1.2&t=312
// Keys at their defaults are left out, so an untouched mix is just #songid.
// guide= names a listening guide (see the guides section below).
// The hash is rewritten with replaceState so Back still returns to the
// previous song rather than stepping through every mute.

const GAIN_MAX = 1.5;
let hashPos = null; // position (s) last written to the hash; null means none

// A song marked "hidden" in songs.json stays out of the picker, the count,
// the next/previous controls and background warming, but still plays from
// a direct link.
function listedSongs() {
  return songs.filter(s => !s.hidden);
}

function findSong(id) {
  return songs.find(s => s.id === id) || listedSongs()[0] || songs[0];
}

function parseStemList(val) {
  const slotIds = SLOTS.map(slot => slot.id);
  return val.split(',').filter(id => slotIds.includes(id));
}

function parseGains(val) {
  const slotIds = SLOTS.map(slot => slot.id);
  const gains = {};
  for (const item of val.split(',')) {
    const [id, v] = item.split(':');
    const n = Number(v);
    if (slotIds.includes(id) && Number.isFinite(n)) gains[id] = Math.max(0, Math.min(GAIN_MAX, n));
  }
  return gains;
}

function parseHash() {
  const [idPart, ...pairs] = location.hash.slice(1).split('&');
  const state = { id: decodeURIComponent(idPart), solo: [], mute: [], gains: {}, t: null, guide: null };
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const val = decodeURIComponent(pair.slice(eq + 1));
    if (key === 'solo' || key === 'mute') {
      state[key] = parseStemList(val);
    } else if (key === 'g') {
      state.gains = parseGains(val);
    } else if (key === 't') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) state.t = n;
    } else if (key === 'guide' && /^[\w-]+$/.test(val)) {
      state.guide = val;
    }
  }
  return state;
}

// The mixer's current mute, solo and fader state, in the shape a hash or a
// guide tip carries it: only non-default gains are listed.
function mixState() {
  return {
    solo: channels.filter(c => c.solo).map(c => c.def.id),
    mute: channels.filter(c => c.mute).map(c => c.def.id),
    gains: Object.fromEntries(channels
      .map(c => [c.def.id, Number(c.ui.fader.value)])
      .filter(([, g]) => g !== 1)),
  };
}

function buildHash() {
  const parts = [song.id];
  const { solo, mute, gains } = mixState();
  const gainList = Object.entries(gains).map(([id, g]) => id + ':' + g);
  if (solo.length) parts.push('solo=' + solo.join(','));
  if (mute.length) parts.push('mute=' + mute.join(','));
  if (gainList.length) parts.push('g=' + gainList.join(','));
  const t = Math.round(hashPos || 0);
  if (t > 0) parts.push('t=' + t);
  if (guideParam) parts.push('guide=' + guideParam);
  return '#' + parts.join('&');
}

function writeHash() {
  if (!song || !channels.length) return;
  const h = buildHash();
  if (h !== location.hash) history.replaceState(null, '', h);
}

// Position goes into the hash only on seek, pause, or Share, never from
// the animation frame.
function writePosition() {
  hashPos = position();
  writeHash();
}

// Apply a parsed hash to the loaded channels. Solos and mutes set here count
// as mixing for the hints, but the listener has not pressed a button, so this
// does not retire the solo hint the way noteMixUsed() would.
function applyMixState(state) {
  for (const c of channels) {
    c.solo = state.solo.includes(c.def.id);
    c.mute = state.mute.includes(c.def.id);
    const g = state.gains[c.def.id] ?? 1;
    c.ui.fader.value = g;
    c.fader.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
  }
  if (state.t !== null) {
    seek(state.t);
    hashPos = offset;
  }
  applyMuteSolo();
  guideSync(false);
}

// ---------- first-run hints ----------
//
// Nudge a new listener toward the two things worth discovering: while a song
// is loaded but paused, Play pulses; while it plays with every channel
// audible, one strip's S button glows for eight seconds, rests for eight, then
// another strip takes a turn. Once they have pressed S or M even once, the
// solo hint is retired for good (remembered in localStorage), since they've
// found the buttons.

const HINT_ON = 8000;
const HINT_OFF = 8000;
const MIX_USED_KEY = 'splitopen.mixUsed';
let hintTimer = null;
let hintIndex = -1;

function mixUsed() {
  try { return localStorage.getItem(MIX_USED_KEY) === '1'; } catch (_) { return false; }
}

function noteMixUsed() {
  try { localStorage.setItem(MIX_USED_KEY, '1'); } catch (_) { /* private mode */ }
  updateHints();
}

function clearSoloHint() {
  clearTimeout(hintTimer);
  hintTimer = null;
  if (hintIndex >= 0 && channels[hintIndex]) channels[hintIndex].ui.solo.classList.remove('hint');
  hintIndex = -1;
}

function advanceSoloHint() {
  if (hintIndex >= 0 && channels[hintIndex]) channels[hintIndex].ui.solo.classList.remove('hint');
  // Pick a strip other than the current one so the hint visibly moves.
  let next = Math.floor(Math.random() * channels.length);
  if (channels.length > 1 && next === hintIndex) next = (next + 1) % channels.length;
  hintIndex = next;
  channels[hintIndex].ui.solo.classList.add('hint');
  hintTimer = setTimeout(() => {
    channels[hintIndex].ui.solo.classList.remove('hint');
    hintTimer = setTimeout(advanceSoloHint, HINT_OFF);
  }, HINT_ON);
}

function updateHints() {
  const loaded = channels.length > 0;
  ui.play.classList.toggle('hint', loaded && !playing);

  const mixing = channels.some(c => c.solo || c.mute);
  const wantSolo = loaded && playing && !mixing && !mixUsed();
  if (!wantSolo) clearSoloHint();
  else if (hintTimer === null) advanceSoloHint();
}

// ---------- transport ----------

// Sources start 50 ms after play(), so for that moment the clock reads a
// little behind the start offset; clamp so the position never steps back.
function position() {
  return playing ? Math.max(offset, Math.min(duration, offset + ctx.currentTime - startedAt)) : offset;
}

function startSources(from) {
  const t0 = ctx.currentTime + 0.05;
  for (const c of channels) {
    const src = ctx.createBufferSource();
    src.buffer = c.buffer;
    src.connect(c.fader);
    src.start(t0, from);
    c.source = src;
  }
  // Any one source ending naturally means the track is over.
  channels[0].source.onended = () => {
    if (playing && position() >= duration - 0.05) stop(0);
  };
  startedAt = t0;
  offset = from;
  playing = true;
}

function stopSources() {
  for (const c of channels) {
    if (!c.source) continue;
    c.source.onended = null;
    try { c.source.stop(); } catch (_) { /* already stopped */ }
    c.source.disconnect();
    c.source = null;
  }
}

function setPlayButton(on) {
  ui.play.classList.toggle('playing', on);
  ui.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
  updateHints();
  mediaSessionState(on);
}

async function play() {
  if (!channels.length) return;
  keepaliveStart(); // must be called synchronously inside the user gesture
  guideWaiting = false;
  // Safari also reports 'interrupted' (phone call, backgrounding); resume covers both.
  if (ctx.state !== 'running') await ctx.resume();
  if (offset >= duration) offset = 0;
  startSources(offset);
  setPlayButton(true);
  guideResume();
}

function pause() {
  offset = position();
  stopSources();
  playing = false;
  keepaliveStop();
  guideWaiting = false;
  stopLoop();
  setPlayButton(false);
  writePosition();
}

function stop(at) {
  stopSources();
  playing = false;
  offset = at;
  keepaliveStop();
  setPlayButton(false);
}

function seek(to) {
  const wasPlaying = playing;
  stopSources();
  playing = false;
  offset = Math.max(0, Math.min(duration, to));
  if (wasPlaying) startSources(offset);
  ui.seek.value = Math.round(offset / duration * 1000);
  ui.cur.textContent = fmt(offset);
  keepaliveSeek(offset);
  mediaSessionPosition();
}

function sheetOpen() {
  return !!((ui.mixSheet && ui.mixSheet.open) || (ui.songSheet && ui.songSheet.open));
}

// Keys typed into a text field belong to the field, not the player.
function isTyping(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(el.type);
}

// Left and Right arrows step the playhead 5 s either way, through seek() so
// the play state is kept. preventDefault stops a focused fader or the seek
// bar from stepping as well.
function wireNudgeKeys() {
  document.addEventListener('keydown', e => {
    if (isTyping(e.target) || sheetOpen()) return;
    if (!channels.length || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    seek(position() + (e.key === 'ArrowLeft' ? -5 : 5));
    guideSync(true);
  });
}

// ---------- media session ----------
// Lock-screen, media-hub, headphone and keyboard media-key controls. All of
// these go through navigator.mediaSession, which browsers only surface while a
// media element is playing; on iOS that is the keep-alive element above.

const MEDIA_ACTIONS = {
  play: () => play(),
  pause: () => pause(),
  seekbackward: d => { seek(position() - ((d && d.seekOffset) || 10)); guideSync(true); },
  seekforward: d => { seek(position() + ((d && d.seekOffset) || 10)); guideSync(true); },
  seekto: d => { if (d && typeof d.seekTime === 'number') { seek(d.seekTime); guideSync(true); } },
  previoustrack: () => mediaSessionStep(-1),
  nexttrack: () => mediaSessionStep(1),
};

function mediaSessionSetHandlers(actions) {
  if (!('mediaSession' in navigator)) return;
  for (const action of actions) {
    try { navigator.mediaSession.setActionHandler(action, MEDIA_ACTIONS[action]); } catch (_) { /* action unsupported */ }
  }
}

// play and pause are registered up front; without them a lock-screen play
// would start the keep-alive element but not the Web Audio graph.
function mediaSessionInstall() {
  mediaSessionSetHandlers(['play', 'pause']);
}

// iOS Safari only tells the system which commands a page supports once a
// media element has registered as Now Playing; handlers set earlier are
// dropped, so the seek and track handlers wait for the keep-alive element's
// first 'playing' event, which fires after that registration.
//
// The iOS lock screen shows either track buttons or seek buttons, and picks
// track buttons when both are registered, so the track handlers are left out
// there. iOS passes its own 15-second interval through details.seekOffset.
const IOS = /iP(hone|ad|od)/.test(navigator.platform)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function mediaSessionWatchKeepalive(el) {
  el.addEventListener('playing', () => {
    mediaSessionSetHandlers(['seekbackward', 'seekforward', 'seekto']);
    if (!IOS) mediaSessionSetHandlers(['previoustrack', 'nexttrack']);
  }, { once: true });
}

// Wraps around the song list, the same way the sidebar switches songs.
function mediaSessionStep(dir) {
  const listed = listedSongs();
  if (!song || !listed.length) return;
  const i = listed.findIndex(s => s.id === song.id);
  location.hash = listed[(i + dir + listed.length) % listed.length].id;
}

function mediaSessionMetadata() {
  if (!('mediaSession' in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: band.name,
      album: `${song.date} · ${song.venue}`,
      artwork: [{ src: new URL('apple-touch-icon.png', location.href).href, sizes: '180x180', type: 'image/png' }],
    });
  } catch (_) { /* MediaMetadata unavailable */ }
}

function mediaSessionState(on) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
  mediaSessionPosition();
}

// Keeps the lock-screen scrubber accurate. Called on play, pause, seek and
// song load; the browser extrapolates between calls, so not every frame.
function mediaSessionPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!channels.length || !(duration > 0)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.max(0, Math.min(duration, position())),
      playbackRate: 1,
    });
  } catch (_) { /* position outside duration */ }
}

// ---------- guides ----------
//
// A guide is a listening tour of a song: an ordered list of tips, each a
// passage, a mix, and a note. The mix holds for the passage; between tips
// the band plays in full. When the playhead crosses into a tip its note is
// shown; a tip marked `pause` also stops the music until the listener
// presses Continue. The text form is the format:
//
//   lang: en
//   title: Solos
//   by: Moshe Weitzman
//   url: https://weitzman.github.io
//   0:00 to=0:30 solo=drums | Fish alone on drums.
//   0:30 to=1:00 solo=drums,bass pause | Mike joins. Listen for the push and pull.
//
// Header lines are `key: value` (title, lang, by, url; lang is the notes'
// language code, which the page passes on to the browser; by and url name
// and link the author). Tip lines start with
// m:ss, then any of to=m:ss (where the tip ends; without it, at the next
// tip), solo=, mute=, g= (as in the hash) and pause, then `|` and the note.
// A later tip may start earlier than the one before it ends, which is how a
// passage is replayed. The hash carries a guide as guide=<slug> for one
// kept in the repo (see guides.json), or guide=z<base64url of the deflated
// text> for one written in the player or by hand; SplitOpen.guideLink(text)
// in the console makes such a link.

function emptyTip(at) {
  return { at, to: null, solo: [], mute: [], gains: {}, pause: false, note: '' };
}

function parseClock(s) {
  const m = /^(\d+):(\d{2}(?:\.\d+)?)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function parseGuideText(text) {
  const g = { title: '', lang: '', by: '', url: '', tips: [] };
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\d+:\d{2}(?:\.\d+)?)\s*([^|]*)(?:\|\s*(.*))?$/.exec(line);
    if (!m) {
      const h = /^(title|lang|by|url):\s*(.*)$/i.exec(line);
      if (h) g[h[1].toLowerCase()] = h[2].trim();
      continue;
    }
    const tip = emptyTip(parseClock(m[1]));
    tip.note = (m[3] || '').trim();
    for (const tok of m[2].trim().split(/\s+/).filter(Boolean)) {
      const eq = tok.indexOf('=');
      const key = eq < 0 ? tok : tok.slice(0, eq);
      const val = eq < 0 ? '' : tok.slice(eq + 1);
      if (key === 'solo' || key === 'mute') tip[key] = parseStemList(val);
      else if (key === 'g') tip.gains = parseGains(val);
      else if (key === 'to') tip.to = parseClock(val);
      else if (key === 'pause') tip.pause = true;
    }
    g.tips.push(tip);
  }
  return g;
}

// deflate + base64url, so a hand-written guide fits in a link: a dozen tips
// with a sentence each come to roughly a kilobyte.
function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
}

async function pipeBytes(bytes, stream) {
  const writer = stream.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function encodeGuide(text) {
  return 'z' + b64urlEncode(await pipeBytes(new TextEncoder().encode(text), new CompressionStream('deflate')));
}

async function decodeGuide(param) {
  if (param[0] !== 'z') throw new Error('unknown guide ' + param);
  if (!window.DecompressionStream) throw new Error('this browser cannot open shared guides');
  return new TextDecoder().decode(await pipeBytes(b64urlDecode(param.slice(1)), new DecompressionStream('deflate')));
}

window.SplitOpen = {
  async guideLink(text) {
    if (!song) throw new Error('load a song first');
    return location.href.split('#')[0] + '#' + song.id + '&guide=' + await encodeGuide(text);
  },
};

// The library: guides.json maps a song id to the slugs of the guides kept
// under guides/<song id>/<slug>.txt. Their headers are read when the song
// loads so the chips can show title and author.
let repoGuides = {};        // song id -> [slug]
let repoGuideMeta = {};     // slug -> { title, by } for the current song

let guideParam = null;  // the hash's guide=, kept while the guide itself loads
let guide = null;       // { param, title, lang, tips }
let guideIndex = -1;    // the tip the playhead is in; -1 before the first
let guideWaiting = false; // paused by a `pause` tip, waiting for Continue

function repoGuideUrl(slug) {
  return `guides/${song.id}/${slug}.txt`;
}

async function fetchRepoGuide(slug) {
  const r = await fetch(repoGuideUrl(slug), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`guide ${slug} not found`);
  return r.text();
}

async function resolveGuide(param) {
  const inRepo = (repoGuides[song.id] || []).includes(param);
  const g = parseGuideText(inRepo ? await fetchRepoGuide(param) : await decodeGuide(param));
  if (!/^https?:\/\//i.test(g.url)) g.url = ''; // only web links, never javascript:
  return { param, title: g.title, lang: g.lang || 'en', by: g.by, url: g.url, tips: g.tips };
}

// Reads the headers of this song's library guides for the chips.
async function loadRepoGuideMeta() {
  const id = song.id;
  repoGuideMeta = {};
  await Promise.all((repoGuides[id] || []).map(async slug => {
    try {
      const g = parseGuideText(await fetchRepoGuide(slug));
      if (song && song.id === id) repoGuideMeta[slug] = { title: g.title, by: g.by };
    } catch (err) {
      console.error(err);
    }
  }));
  if (song && song.id === id) renderGuideChips();
}

// Brings the open guide in line with the hash's guide= value.
async function syncGuide(state) {
  const want = state.guide || null;
  if ((guide ? guide.param : null) === want) return;
  closeGuide(false);
  guideParam = want;
  if (!want) return;
  let g;
  try {
    g = await resolveGuide(want);
  } catch (err) {
    console.error(err);
    const error = want[0] === 'z'
      ? 'This link holds a guide this browser cannot read.'
      : `There is no guide called \u201c${want}\u201d for this song.`;
    g = { param: want, title: 'Guide', lang: 'en', by: '', url: '', tips: [], error };
  }
  if (!channels.length || guideParam !== want) return; // moved on meanwhile
  openGuide(g);
}

function openGuide(g) {
  guide = g;
  guideIndex = -1;
  renderGuide();
  guideSync(false);
  writeHash();
}

function closeGuide(write = true) {
  if (!guide) return;
  clearTimeout(draftTimer);
  guideWaiting = false;
  guide = null;
  guideParam = null;
  guideIndex = -1;
  ui.guide.hidden = true;
  ui.mixer.hidden = !channels.length;
  ui.marks.innerHTML = '';
  loopRange = null;
  tipEdit = null;
  renderGuideChips();
  if (write) writeHash();
}

function setGuide(param) {
  syncGuide({ guide: param });
}

function guideEnd(i) {
  const tips = guide.tips;
  if (tips[i].to !== null) return tips[i].to;
  const next = tips[i + 1];
  return next && next.at > tips[i].at ? next.at : duration;
}

function inTip(i, pos) {
  return pos >= guide.tips[i].at && pos < guideEnd(i);
}

// While writing, the mixer is the author's: the guide highlights tips but
// leaves the mix alone (the jump button still previews a tip's mix).
function guideOwnsMix() {
  return !guide.editing;
}

// After the listener moves the playhead: find the tip that holds it, keeping
// the current one when it still does, and enter it; outside every tip the
// band plays in full. Landing at a tip's start counts as arriving there (so
// a `pause` tip pauses); landing inside it does not.
function guideSync(arrive) {
  if (!guide) return;
  guideWaiting = false;
  if (arrive) stopLoop(); // the listener moved the playhead themselves
  const pos = position();
  const tips = guide.tips;
  const i = guideIndex >= 0 && inTip(guideIndex, pos) ? guideIndex : tips.findIndex((t, k) => inTip(k, pos));
  if (i < 0) leaveTips();
  else if (i !== guideIndex) enterTip(i, arrive && pos - tips[i].at < 1.5);
  else renderGuideNow();
}

// Each frame while playing: once the current tip has run out, move to the
// next one if it starts here (or earlier, which replays the passage); else
// let the band play in full until the next tip begins.
function guideTick(pos) {
  if (!guide || !playing || !guide.tips.length) return;
  const tips = guide.tips;
  if (loopRange !== null) {
    const end = loopRange.to !== null ? loopRange.to : tips[loopRange.i] ? guideEnd(loopRange.i) : duration;
    if (pos >= end - 0.05 || pos < loopRange.at - 0.1) seek(loopRange.at);
    return;
  }
  if (guideIndex >= 0 && pos < tips[guideIndex].at - 0.1) return guideSync(true);
  if (guideIndex >= 0 && pos < guideEnd(guideIndex)) return;
  const next = guideIndex >= 0 ? guideIndex + 1 : tips.findIndex((t, k) => pos >= t.at - 0.25 && pos < guideEnd(k));
  if (guideIndex >= 0 && next < tips.length && tips[next].at < pos - 0.5) {
    seek(tips[next].at);
    return enterTip(next, true);
  }
  if (next >= 0 && next < tips.length && pos >= tips[next].at - 0.25) return enterTip(next, true);
  if (guideIndex >= 0) leaveTips();
}

// On Play: find the tip under the playhead, since the song may have been
// started over from the top.
function guideResume() {
  guideSync(false);
}

function setMix(mix) {
  for (const c of channels) {
    c.solo = mix.solo.includes(c.def.id);
    c.mute = mix.mute.includes(c.def.id);
    const g = mix.gains[c.def.id] ?? 1;
    c.ui.fader.value = g;
    c.fader.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
  }
  applyMuteSolo();
}

// The playhead has left the last tip without entering another.
function leaveTips() {
  const was = guideIndex;
  guideIndex = -1;
  if (was >= 0 && guideOwnsMix()) setMix({ solo: [], mute: [], gains: {} });
  renderGuideNow();
}

// Applies the tip's mix and shows its note. `arrive` means the playhead has
// just reached the tip (as opposed to the guide being opened or the playhead
// dropped somewhere inside it), which is when a `pause` tip pauses.
function enterTip(i, arrive, applyMix = guideOwnsMix()) {
  const tip = guide.tips[i];
  guideIndex = i;
  if (applyMix) setMix(tip);
  if (arrive && tip.pause && playing && !guide.editing) {
    pause();
    guideWaiting = true;
  }
  renderGuideNow();
}

// "Fish · Solo", "Mike, Fish · Solo", "Vocals · Mute" or "Full mix".
function mixParts(tip) {
  const stems = ids => ids.map(id => STEMS.find(s => s.id === id) || { id, who: id, color: '' });
  if (tip.solo.length) return { stems: stems(tip.solo), what: 'Solo' };
  if (tip.mute.length) return { stems: stems(tip.mute), what: 'Mute' };
  return { stems: [], what: 'Full mix' };
}

function guideMixLabel(tip) {
  const { stems, what } = mixParts(tip);
  return stems.length ? stems.map(s => s.who).join(', ') + ' \u00b7 ' + what : what;
}

// The same label as elements, each player's name in their color.
function renderMixLabel(el, tip) {
  const { stems, what } = mixParts(tip);
  el.innerHTML = '';
  stems.forEach((s, i) => {
    const name = document.createElement('span');
    name.className = 'who';
    name.style.color = s.color;
    name.textContent = s.who;
    if (i) el.append(', ');
    el.appendChild(name);
  });
  el.append(stems.length ? ' \u00b7 ' + what : what);
}

// Fills a note element with text clamped to `lines` lines and shows its
// "more" link only when the text actually overflows; the link toggles the
// full text. Overflow is measured after layout, hence the frame wait.
function renderNote(noteEl, moreBtn, text, lines) {
  noteEl.textContent = text;
  noteEl.style.setProperty('--lines', lines);
  noteEl.classList.add('clamp');
  moreBtn.hidden = true;
  moreBtn.textContent = 'more';
  requestAnimationFrame(() => { moreBtn.hidden = noteEl.scrollHeight <= noteEl.clientHeight + 1; });
}

function wireMore(noteEl, moreBtn) {
  moreBtn.addEventListener('click', () => {
    const clamped = noteEl.classList.toggle('clamp');
    moreBtn.textContent = clamped ? 'more' : 'less';
  });
}

function renderGuide() {
  const editing = !!guide.editing;
  const tipEditing = editing && tipEdit !== null;
  ui.guide.hidden = false;
  ui.guide.classList.toggle('editing', editing);
  ui.guide.classList.toggle('tip-editing', tipEditing);
  ui.mixer.hidden = tipEditing; // editing a tip is all about the tip; the mixer makes way
  ui.guide.lang = guide.lang; // the notes' language, for screen readers and hyphenation
  ui.guideKicker.textContent = tipEditing ? 'Editing a tip' : editing ? 'Tips' : 'Guide';
  ui.guideTitle.hidden = editing;
  ui.guideAdd.hidden = !editing || tipEditing;
  ui.guideEdit.textContent = 'Copy & edit';
  // The tip list is always saved, so there is nothing to save; the button
  // only offers to copy a guide being read.
  ui.guideEdit.hidden = editing || !!guide.error || !window.CompressionStream;
  ui.guideClose.hidden = tipEditing;
  ui.guideClose.title = editing ? 'Finish writing; the guide stays in the link' : 'Close this guide';
  ui.guideTitle.textContent = guide.title;
  if (guide.by) {
    ui.guideTitle.append(', by ');
    const who = document.createElement(guide.url ? 'a' : 'span');
    who.className = 'guide-by';
    who.textContent = guide.by;
    if (guide.url) {
      who.href = guide.url;
      who.target = '_blank';
      who.rel = 'noopener';
    }
    ui.guideTitle.appendChild(who);
  }
  ui.guideTips.innerHTML = '';
  ui.marks.innerHTML = '';
  guide.tips.forEach((tip, i) => {
    const mark = document.createElement('i');
    mark.style.left = (tip.at / duration * 100).toFixed(2) + '%';
    if (tip.to !== null) mark.style.width = 'max(2px, ' + ((tip.to - tip.at) / duration * 100).toFixed(2) + '%)';
    ui.marks.appendChild(mark);
    if (tipEditing) {
      if (i === tipEdit.i) ui.guideTips.appendChild(buildTipEditor(tip, i));
      return;
    }
    ui.guideTips.appendChild(buildTipRow(tip, i, editing));
  });
  renderGuideChips();
  renderGuideNow();
  renderEditMark();
}

// "0:32–0:48", or just the start for a tip that runs to the next one.
function tipSpan(tip) {
  return tip.to === null ? fmt(tip.at) : fmt(tip.at) + '–' + fmt(tip.to);
}

function goToTip(i) {
  guideWaiting = false;
  seek(guide.tips[i].at);
  writePosition();
  enterTip(i, true, true);
}

// The current tip is highlighted in the list; long notes stay clamped
// behind "more" until the listener opens them.
function renderGuideNow() {
  if (!guide) return;
  const hint = !guide.editing || guide.tips.length ? ''
    : 'Play the song, set mute/solo, and click <em>Tip: Start</em> where a passage worth a tip begins. '
      + 'When done adding tips and descriptions, click <em>Share</em> '
      + '<svg class="inline-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16"/><path d="M12 15V3M8 7l4-4 4 4"/></svg>'
      + ' to send a link to your creation.';
  if (guide.error) ui.guideStatus.textContent = guide.error;
  else ui.guideStatus.innerHTML = hint; // our own copy, no user text
  ui.guideStatus.hidden = !(guide.error || hint);
  ui.guideStatus.classList.toggle('error', !!guide.error);
  ui.guideContinue.hidden = !guideWaiting;
  Array.from(ui.guideTips.children).forEach((li, i) => li.classList.toggle('on', i === guideIndex));
  Array.from(ui.marks.children).forEach((mark, i) => mark.classList.toggle('on', i === guideIndex));
  const loopingRow = loopRange === null ? null : ui.guideTips.querySelector(`[data-tip="${loopRange.i}"]`);
  ui.guideTips.querySelectorAll('.looping').forEach(li => li.classList.remove('looping'));
  if (loopingRow) loopingRow.classList.add('looping');
  // Keep the current tip in view within the list only; scrollIntoView
  // would drag the whole page along on a phone.
  const list = ui.guideTips;
  const on = list.children[guideIndex];
  if (on) {
    if (on.offsetTop < list.scrollTop) list.scrollTop = on.offsetTop;
    else if (on.offsetTop + on.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = on.offsetTop + on.offsetHeight - list.clientHeight;
    }
  }
}

// The pills under the song title: the song's library guides, plus the open
// guide when it arrived in the link. Titles only; the author is shown in
// the panel.
function renderGuideChips() {
  const row = document.getElementById('guides');
  row.innerHTML = '';
  if (!song) return;
  const label = document.createElement('span');
  label.className = 'guides-label';
  label.textContent = 'Guides';
  row.appendChild(label);
  const entries = [];
  for (const slug of repoGuides[song.id] || []) {
    const meta = repoGuideMeta[slug] || { title: slug, by: '' };
    entries.push({ param: slug, title: meta.title, by: meta.by });
  }
  if (guide && !(repoGuides[song.id] || []).includes(guide.param)) entries.push(guide);
  for (const { param, title, by } of entries) {
    const btn = document.createElement('button');
    btn.className = 'song chip';
    btn.textContent = title || 'Untitled guide';
    if (by) btn.title = 'by ' + by; // the author shows in the panel, not the pill
    btn.classList.toggle('on', !!guide && guide.param === param);
    btn.addEventListener('click', () => {
      if (!channels.length || !leaveDraftOk()) return;
      if (guide && guide.param === param) closeGuide();
      else setGuide(param);
    });
    row.appendChild(btn);
  }
  if (window.CompressionStream && !(guide && guide.editing)) {
    const btn = document.createElement('button');
    btn.className = 'song chip new';
    btn.textContent = '+ New guide';
    btn.addEventListener('click', newGuide);
    row.appendChild(btn);
  }
}

function wireGuide() {
  ui.guide = document.getElementById('guide');
  ui.guideTitle = document.getElementById('guide-title');
  ui.guideStatus = document.getElementById('guide-status');
  ui.guideTips = document.getElementById('guide-tips');
  ui.guideContinue = document.getElementById('guide-continue');
  ui.marks = document.getElementById('marks');
  ui.guideKicker = document.getElementById('guide-kicker');
  ui.guideAdd = document.getElementById('guide-add');
  ui.guideEdit = document.getElementById('guide-edit');
  ui.guideClose = document.getElementById('guide-close');
  ui.mixer = document.getElementById('mixer');
  ui.guideContinue.addEventListener('click', () => { guideWaiting = false; play(); });
  ui.guideAdd.addEventListener('click', startTip);
  ui.guideEdit.addEventListener('click', () => (guide && guide.editing ? finishEditing() : editGuide()));
  // While writing, the close button finishes writing and shows the guide as
  // readers will see it; the guide stays in the link. Closing that view
  // drops the guide.
  document.getElementById('guide-close').addEventListener('click', () => {
    if (guide && guide.editing) finishEditing();
    else closeGuide();
  });
}

// ---------- guide authoring ----------
//
// A guide is written in the player itself. Start a new one (or edit the open
// one), play the song, set the mix, and press N (Tip: Start) where a passage
// worth a tip begins and again (Tip: End) where it ends: the tip takes that
// passage and the mix in force when it started, and its note is typed in
// place. The draft is re-encoded into the hash as it changes, so Share hands
// it out and a reload brings it back. A draft never pauses at its own
// `pause` tips.
// The title, author and language are not asked for here; they come later,
// when a guide is offered to the library.

let draftTimer = null;
let draftSeq = 0;

function clock(s) {
  const tenths = Math.round(s * 10);
  const frac = tenths % 10;
  return fmt(Math.floor(tenths / 10)) + (frac ? '.' + frac : '');
}

// The text form of a guide, the inverse of parseGuideText.
function guideText(g) {
  const lines = [];
  if (g.title) lines.push('title: ' + g.title);
  if (g.lang) lines.push('lang: ' + g.lang);
  if (g.by) lines.push('by: ' + g.by);
  if (g.url) lines.push('url: ' + g.url);
  for (const s of g.tips) {
    const keys = [];
    if (s.solo.length) keys.push('solo=' + s.solo.join(','));
    if (s.mute.length) keys.push('mute=' + s.mute.join(','));
    const gains = Object.entries(s.gains).filter(([, v]) => v !== 1).map(([id, v]) => id + ':' + v);
    if (gains.length) keys.push('g=' + gains.join(','));
    if (s.to !== null) keys.push('to=' + clock(s.to));
    if (s.pause) keys.push('pause');
    lines.push([clock(s.at), ...keys].join(' ') + ' | ' + s.note.replace(/\s*\n\s*/g, ' ').trim());
  }
  return lines.join('\n') + '\n';
}

// The draft is always in the link, so leaving it only needs a word when
// that link has not been shared; the guide pill brings it back meanwhile.
function leaveDraftOk() {
  if (!guide || !guide.editing || !guide.tips.length) return true;
  return confirm('Leave the guide you are writing? Share it first to keep a link.');
}

function newGuide() {
  if (!channels.length || !leaveDraftOk()) return;
  closeGuide(false);
  const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
  openGuide({ param: null, title: '', lang, by: '', url: '', tips: [], editing: true });
  draftChanged();
}

// Turns the open guide into a draft of its own: a template becomes a
// starting point, a shared guide a copy to revise. The copy is the new
// author's, so it is named after its source and the credit is left for
// them to give later.
function editGuide() {
  if (!guide || guide.editing || guide.error) return;
  guide = {
    ...guide,
    param: null,
    editing: true,
    title: guide.title ? guide.title.replace(/ \(copy\)$/, '') + ' (copy)' : '',
    by: '',
    url: '',
    tips: guide.tips.map(s => ({ ...s, solo: [...s.solo], mute: [...s.mute], gains: { ...s.gains } })),
  };
  guideIndex = -1;
  renderGuide();
  guideSync(false);
  draftChanged();
}

async function finishEditing() {
  if (!guide || !guide.editing) return;
  tipEdit = null;
  clearTimeout(draftTimer);
  draftSeq++;
  guide.editing = false;
  stopLoop();
  guide.param = guideParam = await encodeGuide(guideText(guide));
  guideIndex = -1;
  renderGuide();
  guideSync(false);
  writeHash();
}

// Re-encodes the draft into the hash shortly after it last changed.
function draftChanged() {
  if (!guide || !guide.editing) return;
  const seq = ++draftSeq;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    const param = await encodeGuide(guideText(guide));
    if (seq !== draftSeq || !guide || !guide.editing) return;
    guide.param = guideParam = param;
    writeHash();
    renderGuideChips();
  }, 300);
}

// Tip: Start (or N) adds a tip at the playhead with the mixer's current
// state, placed among the others by time (a replayed passage can be dragged
// into place). A tip runs to the next tip unless an end is set in its
// editor.
function startTip() {
  if (!guide || !guide.editing || tipEdit !== null || !channels.length) return;
  const at = Math.round(position() * 10) / 10;
  const tip = { ...emptyTip(at), ...mixState() };
  let i = 0;
  while (i < guide.tips.length && guide.tips[i].at <= at) i++;
  guide.tips.splice(i, 0, tip);
  tipsChanged();
}

// After a tip is added, removed, moved or re-timed: rebuild the list and
// marks and find the current tip afresh, since the indexes have shifted.
function tipsChanged() {
  guideIndex = -1;
  renderGuide();
  guideSync(false);
  draftChanged();
}

const ICON_PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M7 4l14 8-14 8z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

// One row per tip, the same whether the guide is being read or written:
// the mix, the start (and a quiet optional end), and the note clamped
// behind "more". Writing adds a drag handle and edit / play / delete.
// Clicking the mix or times jumps to the tip.
function buildTipRow(tip, i, editable) {
  const li = document.createElement('li');
  li.className = 'tip-row' + (editable ? ' edit' : '');
  li.dataset.tip = i;
  li.tip = tip;
  li.innerHTML = `
    ${editable ? '<span class="handle" title="Drag to reorder" aria-label="Drag to reorder">&#8942;&#8942;</span>' : ''}
    <button class="jump" title="Jump to this tip">
      <span class="mix"></span>
      <span class="when"><span class="at"></span><span class="to"></span></span>
    </button>
    ${editable ? `<span class="actions">
      <button class="icon edit" title="Edit this tip" aria-label="Edit this tip">${ICON_PENCIL}</button>
      <button class="icon loop" title="Play this Tip in a loop" aria-label="Play this Tip in a loop">${ICON_PLAY}</button>
      <button class="icon del" title="Delete this tip" aria-label="Delete this tip">${ICON_TRASH}</button>
    </span>` : ''}
    <span class="note"></span>
    <button class="more">more</button>`;
  renderMixLabel(li.querySelector('.mix'), tip);
  li.querySelector('.at').textContent = fmt(tip.at);
  li.querySelector('.to').textContent = tip.to === null ? '' : ' \u2013 ' + fmt(tip.to);
  const note = li.querySelector('.note');
  const more = li.querySelector('.more');
  if (tip.note) {
    renderNote(note, more, tip.note, 2);
    wireMore(note, more);
  } else {
    note.hidden = true;
    more.hidden = true;
  }
  li.querySelector('.jump').addEventListener('click', () => goToTip(i));
  if (editable) {
    li.querySelector('.edit').addEventListener('click', () => editTip(i));
    li.querySelector('.loop').addEventListener('click', () => (loopRange && loopRange.i === i ? pause() : startLoop(i)));
    li.querySelector('.del').addEventListener('click', () => {
      guide.tips.splice(i, 1);
      tipsChanged();
    });
    wireDrag(li.querySelector('.handle'), li);
  }
  return li;
}

// Editing one tip: the list and the mixer step aside for its times and
// description. Play loops the passage as currently typed; Save keeps the
// changes, Discard drops them.
let tipEdit = null; // { i, at, to, note } while a tip is being edited

function editTip(i) {
  const tip = guide.tips[i];
  stopLoop();
  tipEdit = { i, at: tip.at, to: tip.to, note: tip.note, solo: [...tip.solo], mute: [...tip.mute] };
  renderGuide();
}

function buildTipEditor(tip, i) {
  const li = document.createElement('li');
  li.className = 'tip-editor';
  li.dataset.tip = i;
  li.innerHTML = `
    <div class="card-head">
      <button class="mix-btn" title="Change which players this tip solos or mutes"><span class="mix"></span><span class="mix-hint">change</span></button>
    </div>
    <div class="times">
      <span class="time-row">
        <span class="time-label">Start</span>
        <span class="time-value at"></span>
        <button class="mini set-at" title="Set the start to where the playhead is">Set</button>
      </span>
      <span class="time-row opt">
        <span class="time-label">End</span>
        <span class="time-value to"></span>
        <button class="mini set-to" title="Set the end to where the playhead is">Set</button>
        <button class="mini clear-to" title="Clear the end" aria-label="Clear the end">&times;</button>
      </span>
      <span class="scrub-hint">Scrub or play to a moment, then Set.</span>
    </div>
    <textarea class="edit-note" rows="5" placeholder="What to listen for here"></textarea>
    <div class="actions">
      <button class="btn save">Save</button>
      <button class="btn loop" title="Play this Tip in a loop">${ICON_PLAY}<span>Play</span></button>
      <button class="btn discard">Discard</button>
    </div>`;
  const mixLabel = li.querySelector('.mix');
  renderMixLabel(mixLabel, tipEdit);
  li.querySelector('.mix-btn').addEventListener('click', () => openMixSheet(tip, () => renderMixLabel(mixLabel, tipEdit)));
  const at = li.querySelector('.at');
  const to = li.querySelector('.to');
  const clearTo = li.querySelector('.clear-to');
  const setTo = li.querySelector('.set-to');
  const note = li.querySelector('textarea');
  note.value = tipEdit.note;
  const showTimes = () => {
    at.textContent = clock(tipEdit.at);
    to.textContent = tipEdit.to === null ? '\u2014' : clock(tipEdit.to);
    to.classList.toggle('unset', tipEdit.to === null);
    setTo.classList.toggle('quiet', tipEdit.to === null);
    clearTo.disabled = tipEdit.to === null;
    renderEditMark();
  };
  showTimes();
  li.querySelector('.set-at').addEventListener('click', () => {
    tipEdit.at = Math.round(position() * 10) / 10;
    if (tipEdit.to !== null && tipEdit.to <= tipEdit.at) tipEdit.to = null; // an end before the start is no end
    showTimes();
  });
  li.querySelector('.set-to').addEventListener('click', () => {
    const pos = Math.round(position() * 10) / 10;
    tipEdit.to = Math.min(duration, Math.max(tipEdit.at + 1, pos));
    showTimes();
  });
  clearTo.addEventListener('click', () => { tipEdit.to = null; showTimes(); });
  note.addEventListener('input', () => { tipEdit.note = note.value; });
  li.querySelector('.save').addEventListener('click', () => {
    Object.assign(tip, { at: tipEdit.at, to: tipEdit.to, note: tipEdit.note, solo: tipEdit.solo, mute: tipEdit.mute });
    tipEdit = null;
    stopLoop();
    tipsChanged();
  });
  li.querySelector('.discard').addEventListener('click', () => {
    tipEdit = null;
    stopLoop();
    guideIndex = -1;
    renderGuide();
    guideSync(false);
  });
  li.querySelector('.loop').addEventListener('click', () => (loopRange ? pause() : startLoop(i, tipEdit.at, tipEdit.to, { ...tip, solo: tipEdit.solo, mute: tipEdit.mute })));
  return li;
}

// The mix sheet: a modal with one row per player, Mute and Solo as on the
// strips. What is chosen is heard at once, so with the passage looping the
// mix is auditioned as it is built. "Use this mix" keeps it for the tip
// being edited; Cancel (or Escape) restores what was playing before.
let sheetMix = null;   // { solo, mute } being chosen
let sheetBefore = null; // the mixer's state when the sheet opened
let sheetGains = {};
let sheetAccepted = false;
let sheetOnUse = null;

function openMixSheet(tip, onUse) {
  if (!tipEdit) return;
  sheetMix = { solo: [...tipEdit.solo], mute: [...tipEdit.mute] };
  sheetGains = tip.gains;
  sheetBefore = mixState();
  sheetAccepted = false;
  sheetOnUse = onUse;
  renderMixSheet();
  setMix({ ...sheetMix, gains: sheetGains });
  ui.mixSheet.showModal();
}

// Each row offers only what makes sense: while anything is soloed, Mute
// disappears (the unsoloed players are silent already); a soloed player
// shows just its lit Solo; otherwise Mute and Solo both show, and a muted
// player's lit Mute unmutes it. A tap on the row itself means Solo.
function renderMixSheet() {
  const rows = ui.mixSheetRows;
  rows.innerHTML = '';
  const anySolo = sheetMix.solo.length > 0;
  for (const s of STEMS) {
    const soloed = sheetMix.solo.includes(s.id);
    const muted = sheetMix.mute.includes(s.id);
    const row = document.createElement('div');
    row.className = 'sheet-row';
    row.classList.toggle('inactive', anySolo ? !soloed : muted);
    row.style.setProperty('--c', s.color);
    row.innerHTML = `<span class="who">${s.who}</span><span class="inst">${s.inst}</span>
      <button class="btn mute">Mute</button><button class="btn solo">Solo</button>`;
    const mute = row.querySelector('.mute');
    const solo = row.querySelector('.solo');
    mute.hidden = anySolo;
    mute.classList.toggle('on', muted);
    solo.classList.toggle('on', soloed);
    mute.addEventListener('click', e => { e.stopPropagation(); sheetToggle('mute', s.id); });
    solo.addEventListener('click', e => { e.stopPropagation(); sheetToggle('solo', s.id); });
    row.addEventListener('click', () => sheetToggle('solo', s.id));
    rows.appendChild(row);
  }
  ui.mixSheetFull.hidden = !sheetMix.solo.length && !sheetMix.mute.length;
}

// Mute and Solo exclude each other for a player.
function sheetToggle(key, id) {
  const list = sheetMix[key];
  const other = sheetMix[key === 'solo' ? 'mute' : 'solo'];
  const k = list.indexOf(id);
  if (k < 0) {
    list.push(id);
    const o = other.indexOf(id);
    if (o >= 0) other.splice(o, 1);
  } else {
    list.splice(k, 1);
  }
  renderMixSheet();
  setMix({ ...sheetMix, gains: sheetGains });
}

function wireMixSheet() {
  ui.mixSheet = document.getElementById('mix-sheet');
  ui.mixSheetRows = document.getElementById('mix-sheet-rows');
  ui.mixSheetFull = document.getElementById('mix-sheet-full');
  ui.mixSheetFull.addEventListener('click', () => {
    sheetMix = { solo: [], mute: [] };
    renderMixSheet();
    setMix({ ...sheetMix, gains: sheetGains });
  });
  document.getElementById('mix-sheet-use').addEventListener('click', () => {
    sheetAccepted = true;
    ui.mixSheet.close();
  });
  document.getElementById('mix-sheet-cancel').addEventListener('click', () => ui.mixSheet.close());
  // Closing by any route: keep or restore.
  ui.mixSheet.addEventListener('close', () => {
    if (sheetAccepted && tipEdit) {
      tipEdit.solo = sheetMix.solo;
      tipEdit.mute = sheetMix.mute;
      if (sheetOnUse) sheetOnUse();
    } else if (sheetBefore) {
      setMix(sheetBefore);
    }
    sheetMix = sheetBefore = sheetOnUse = null;
  });
  // A tap on the dim backdrop cancels.
  ui.mixSheet.addEventListener('click', e => { if (e.target === ui.mixSheet) ui.mixSheet.close(); });
}

// While a tip is edited, its mark on the seek bar follows the times being
// set, so start and end can be seen against the playhead.
function renderEditMark() {
  if (!guide || tipEdit === null) return;
  const mark = ui.marks.children[tipEdit.i];
  if (!mark) return;
  const end = tipEdit.to !== null ? tipEdit.to : (guide.tips[tipEdit.i + 1] && guide.tips[tipEdit.i + 1].at > tipEdit.at ? guide.tips[tipEdit.i + 1].at : duration);
  mark.classList.add('editing');
  mark.style.left = (tipEdit.at / duration * 100).toFixed(2) + '%';
  mark.style.width = 'max(2px, ' + ((end - tipEdit.at) / duration * 100).toFixed(2) + '%)';
}

// A passage looping while it is edited or auditioned from the list.
let loopRange = null; // { i, at, to }

// Loops a tip's passage with its mix; a start and end other than the tip's
// own let the tip editor preview times as typed.
function startLoop(i, at = guide.tips[i].at, to = guide.tips[i].to, mix = guide.tips[i]) {
  loopRange = { i, at, to };
  setMix(mix);
  seek(at);
  enterTip(i, false, false);
  if (!playing) play();
  renderGuideNow();
}

function stopLoop() {
  if (loopRange === null) return;
  loopRange = null;
  if (guide) renderGuideNow();
}

// Reordering by drag: the handle captures the pointer, the row follows it
// past its neighbours' midpoints, and the list's new order becomes the
// guide's when the pointer lifts.
function wireDrag(handle, li) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* no live pointer (synthetic event) */ }
    li.classList.add('dragging');
    const list = ui.guideTips;
    const move = ev => {
      const rows = Array.from(list.children);
      const cur = rows.indexOf(li);
      for (const row of rows) {
        if (row === li) continue;
        const r = row.getBoundingClientRect();
        const idx = rows.indexOf(row);
        if (idx < cur && ev.clientY < r.top + r.height / 2) { list.insertBefore(li, row); break; }
        if (idx > cur && ev.clientY > r.top + r.height / 2) { list.insertBefore(li, row.nextSibling); break; }
      }
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      li.classList.remove('dragging');
      guide.tips = Array.from(list.children).map(row => row.tip);
      tipsChanged();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
}

// ---------- UI ----------

const ui = {};

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function buildStrip(c, index) {
  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.style.setProperty('--c', c.def.color);
  strip.innerHTML = `
    <div class="who">${c.def.who}</div>
    <div class="inst">${c.def.inst}</div>
    <div class="meter-fader">
      <div class="meter"><div class="meter-fill"></div></div>
      <div class="fader-wrap">
        <input class="fader" type="range" min="0" max="1.5" step="0.01" value="1" aria-label="${c.def.who} level">
      </div>
    </div>
    <div class="buttons">
      <button class="btn mute" title="Mute (shift+${index + 1})"><span class="short">M</span><span class="long">Mute</span></button>
      <button class="btn solo" title="Solo (${index + 1})"><span class="short">S</span><span class="long">Solo</span></button>
    </div>
  `;
  const fader = strip.querySelector('.fader');
  const mute = strip.querySelector('.mute');
  const solo = strip.querySelector('.solo');
  const meter = strip.querySelector('.meter-fill');

  fader.addEventListener('input', () => {
    c.fader.gain.setTargetAtTime(Number(fader.value), ctx.currentTime, 0.01);
  });
  fader.addEventListener('change', writeHash);
  mute.addEventListener('click', () => { c.mute = !c.mute; noteMixUsed(); applyMuteSolo(); });
  solo.addEventListener('click', () => { c.solo = !c.solo; noteMixUsed(); applyMuteSolo(); });

  c.ui = { strip, mute, solo, meter, fader };
  return strip;
}

const meterBuf = new Uint8Array(1024);
function tick() {
  if (channels.length) {
    const pos = position();
    if (!ui.seeking) ui.seek.value = Math.round(pos / duration * 1000);
    ui.cur.textContent = fmt(pos);
    guideTick(pos);

    for (const c of channels) {
      c.analyser.getByteTimeDomainData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) {
        const v = (meterBuf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / meterBuf.length);
      // ~ -40 dB floor to 0 dB ceiling, mapped to 0..100%
      const db = 20 * Math.log10(rms || 1e-5);
      const pct = Math.max(0, Math.min(100, (db + 40) / 40 * 100));
      c.ui.meter.style.setProperty('--lvl', pct.toFixed(1) + '%');
    }
  }
  requestAnimationFrame(tick);
}

function wireTransport() {
  ui.play = document.getElementById('play');
  ui.seek = document.getElementById('seek');
  ui.cur = document.getElementById('time-cur');
  ui.dur = document.getElementById('time-dur');
  ui.share = document.getElementById('share');

  ui.play.addEventListener('click', () => playing ? pause() : play());
  ui.share.addEventListener('click', shareLink);
  ui.seek.addEventListener('pointerdown', () => { ui.seeking = true; });
  ui.seek.addEventListener('input', () => {
    ui.cur.textContent = fmt(ui.seek.value / 1000 * duration);
  });
  ui.seek.addEventListener('change', () => {
    ui.seeking = false;
    seek(ui.seek.value / 1000 * duration);
    writePosition();
    guideSync(true);
  });
  wireNudgeKeys();

  document.addEventListener('keydown', e => {
    if (isTyping(e.target) || sheetOpen()) return;
    if (e.target.tagName === 'INPUT') e.target.blur(); // a focused fader or the seek bar
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openSongPicker(); return; }
    if (!channels.length) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); return; }
    if (e.code === 'KeyL' && !e.metaKey && !e.ctrlKey && !e.altKey) { shareLink(); return; }
    if (e.code === 'KeyN' && !e.metaKey && !e.ctrlKey && !e.altKey) { startTip(); return; }
    const n = Number(e.code.replace('Digit', ''));
    if (e.code.startsWith('Digit') && n >= 1 && n <= channels.length) {
      const c = channels[n - 1];
      if (e.shiftKey) c.mute = !c.mute; else c.solo = !c.solo;
      noteMixUsed();
      applyMuteSolo();
    }
  });
}

// Fallback for webviews that deny the Clipboard API: the legacy copy command
// still honors a recent click.
function copyViaSelection(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { /* unsupported */ }
  ta.remove();
  return ok;
}

// Shares a link to the current mix at the current moment, so the position is
// committed to the hash first. Where the browser has a share sheet (iOS and
// Android, Safari and Chrome on the desktop) it opens with the link; the call
// has to happen inside the click or key gesture, before any await. Elsewhere
// the link is copied to the clipboard. Dismissing the sheet is not a failure.
let shareTimer = null;
async function shareLink() {
  if (!channels.length) return;
  writePosition();
  const url = location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch (_) {
    ok = copyViaSelection(url);
  }
  ui.share.classList.toggle('copied', ok);
  ui.share.classList.toggle('failed', !ok);
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => { ui.share.classList.remove('copied', 'failed'); }, 1500);
}

function renderHeader() {
  document.getElementById('title').textContent = song.title;
  document.getElementById('venue').textContent = `${song.date} · ${song.venue} · ${song.city}`;
  document.title = `Split Open — ${song.title}`;
  renderGuideChips();
  for (const row of document.querySelectorAll('.song-row')) {
    row.classList.toggle('on', row.dataset.id === song.id);
  }
  mediaSessionMetadata();
}

// ---------- song picker ----------
//
// The title is the picker: it opens a sheet listing every song grouped by
// band, with a search box that filters by title, band, venue, city or
// date. Picking one sets the hash, as the old chips did.

function renderSongList(filter = '') {
  const list = document.getElementById('song-list');
  list.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const byBand = new Map();
  for (const s of listedSongs()) {
    const who = (bands[s.band] || {}).name || s.band;
    const hay = `${s.title} ${who} ${s.venue} ${s.city} ${s.date}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    if (!byBand.has(who)) byBand.set(who, []);
    byBand.get(who).push(s);
  }
  if (!byBand.size) {
    const none = document.createElement('p');
    none.className = 'song-none';
    none.textContent = 'No songs match.';
    list.appendChild(none);
    return;
  }
  for (const [who, group] of byBand) {
    const h = document.createElement('h3');
    h.className = 'song-band';
    h.textContent = who;
    list.appendChild(h);
    for (const s of group) {
      const row = document.createElement('button');
      row.className = 'song-row';
      row.dataset.id = s.id;
      row.classList.toggle('on', !!song && s.id === song.id);
      row.innerHTML = `<span class="song-title"></span><span class="song-where"></span>`;
      row.querySelector('.song-title').textContent = s.title;
      row.querySelector('.song-where').textContent = `${s.date} · ${s.venue}, ${s.city}`;
      row.addEventListener('click', () => {
        ui.songSheet.close();
        if (song && s.id === song.id) return;
        if (!leaveDraftOk()) return;
        location.hash = s.id;
      });
      list.appendChild(row);
    }
  }
}

function openSongPicker() {
  if (!songs.length || ui.songSheet.open) return;
  ui.songSearch.value = '';
  renderSongList();
  ui.songSheet.showModal();
  // showModal() focuses the first field, the search box. That is right
  // where a keyboard is at hand; on a phone it would raise the keyboard
  // over the list, so focus goes to the sheet itself instead.
  if (matchMedia('(hover: none) and (pointer: coarse)').matches) ui.songSheet.focus();
  else ui.songSearch.focus();
  const on = ui.songSheet.querySelector('.song-row.on');
  if (on) on.scrollIntoView({ block: 'center' });
}

function wireSongPicker() {
  ui.songSheet = document.getElementById('song-sheet');
  ui.songSearch = document.getElementById('song-search');
  document.getElementById('song-pick').addEventListener('click', openSongPicker);
  ui.songSearch.addEventListener('input', () => renderSongList(ui.songSearch.value));
  ui.songSheet.addEventListener('click', e => { if (e.target === ui.songSheet) ui.songSheet.close(); });
  // Up and Down walk the list (from the search box, Down goes to the first
  // song and Up to the last); Enter in the search box picks the first match.
  ui.songSheet.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    const rows = Array.from(ui.songSheet.querySelectorAll('.song-row'));
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'Enter') {
      if (document.activeElement === ui.songSearch) { e.preventDefault(); rows[0].click(); }
      return;
    }
    e.preventDefault();
    let next;
    if (i < 0) next = e.key === 'ArrowDown' ? 0 : rows.length - 1;
    else next = (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
  });
  // The pill on the title says how many songs there are to choose from.
  const pill = document.getElementById('pick-pill');
  const n = listedSongs().length;
  document.getElementById('pick-count').textContent = n + (n === 1 ? ' song' : ' songs');
  pill.hidden = false;
}

// ---------- song switching ----------

async function loadSong(state) {
  const next = findSong(state.id);
  if (song && next.id === song.id) return;
  const token = ++loadToken;

  closeGuide(false);
  teardownChannels();
  hashPos = null;
  song = next;
  band = bands[song.band] || bands.phish || { name: song.band, channels: {} };
  // Band layout, then per-song overrides (e.g. a guest sitting in on one stem).
  STEMS = SLOTS.map(slot => ({
    ...slot, who: slot.id, inst: '',
    ...(band.channels[slot.id] || {}),
    ...((song.channels || {})[slot.id] || {}),
  }));
  renderHeader();
  loadRepoGuideMeta();
  setPlayButton(false);

  const mixer = document.getElementById('mixer');
  const loading = document.getElementById('loading');
  mixer.innerHTML = '';
  mixer.hidden = true;
  document.getElementById('transport').hidden = true;
  loading.hidden = false;

  try {
    const buffers = await loadAllStems(song);
    if (token !== loadToken) return; // user switched songs mid-load
    duration = Math.max(...buffers.map(b => b.duration));
    buffers.forEach((buf, i) => {
      const c = buildChannel(STEMS[i], buf);
      channels.push(c);
      mixer.appendChild(buildStrip(c, i));
    });
    ui.dur.textContent = fmt(duration);
    ui.seek.value = 0;
    ui.cur.textContent = fmt(0);
    mediaSessionPosition();
    loading.hidden = true;
    mixer.hidden = false;
    document.getElementById('transport').hidden = false;
    applyMixState(state);
    syncGuide(state);
    warmOtherSongs(song);
  } catch (err) {
    if (token !== loadToken) return;
    document.getElementById('loading-label').textContent = 'Failed to load stems: ' + err.message;
    console.error(err);
  }
}

// ---------- boot ----------

(async () => {
  wireTransport();
  wireGuide();
  wireMixSheet();
  mediaSessionInstall();
  tick();
  try {
    [songs, bands, repoGuides] = await Promise.all([
      fetch('songs.json', { cache: 'no-cache' }).then(r => r.json()),
      fetch('bands.json', { cache: 'no-cache' }).then(r => r.json()),
      fetch('guides.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
  } catch (err) {
    document.getElementById('loading-label').textContent = 'Failed to load song list: ' + err.message;
    return;
  }
  wireSongPicker();
  const fromHash = () => loadSong(parseHash());
  window.addEventListener('hashchange', () => {
    // Our own replaceState writes never fire this, so it is a song click, a
    // Back/Forward step, or a hand-edited URL. A same-song change only has
    // to apply the mix; only a new song id loads stems (or reloads the page).
    const state = parseHash();
    if (song && channels.length && findSong(state.id).id === song.id) {
      applyMixState(state);
      return syncGuide(state);
    }
    if (!(LOW_MEMORY && song)) return fromHash();
    // Drop every reference to the old song's PCM before the reload. Safari
    // keeps the same process across a reload and collects the old page's
    // heap lazily, so the less we leave behind the better.
    teardownChannels();
    decodedCache.clear();
    decodedBytes.clear();
    byteCache.clear();
    bytesReady.clear();
    ctx.close().catch(() => {});
    location.reload();
  });
  fromHash();
})();
