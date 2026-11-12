'use strict';

// ---------- tiny helpers ----------
const { t, ts } = window.i18n;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const icon = (name, cls) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
};
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};
const fmtSize = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtGb = (b) => (Math.round((b / 1073741824) * 10) / 10).toString();
const fmtTime = (s) => (s ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '');

async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || t('oops'));
    err.status = res.status;
    err.locked = !!data.locked;
    throw err;
  }
  return data;
}
const postJson = (path, body, method = 'POST') => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toast(message, bad) {
  const node = el('div', 'toast' + (bad ? ' bad' : ''), message);
  $('#toasts').append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

function showAlert(id, message) {
  const box = $(id);
  box.textContent = message || '';
  box.hidden = !message;
}

// ---------- theme ----------
// The new theme opens as a circle growing out of the button. The browser
// animates two finished pictures of the page (a view transition), so the
// switch stays smooth at the screen's refresh rate. Without that feature, or
// when the visitor asked for less motion, the colours simply fade.
$('#theme').addEventListener('click', (event) => {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  const apply = () => {
    root.setAttribute('data-theme', next);
    store.set('theme', next);
  };
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || calm) {
    if (!calm) {
      root.classList.add('theme-fade');
      setTimeout(() => root.classList.remove('theme-fade'), 500);
    }
    apply();
    return;
  }
  const box = event.currentTarget.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  root.style.setProperty('--vt-x', x + 'px');
  root.style.setProperty('--vt-y', y + 'px');
  root.style.setProperty('--vt-r', Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) + 'px');
  document.startViewTransition(apply);
});

// ---------- greeting ----------
function greet() {
  const h = new Date().getHours();
  $('#greet').textContent = t(h < 5 ? 'upLate' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening') + ' ' + t('greetTail');
}
greet();

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => {
      const on = other === tab;
      other.classList.toggle('active', on);
      other.setAttribute('aria-selected', String(on));
      $('#panel-' + other.dataset.tab).hidden = !on;
    });
  });
});

// ---------- formats and their options ----------
let boot = null;
let formats = [];
let current = null;

function savedOptions(id) {
  try {
    return JSON.parse(store.get('opts-' + id, '{}')) || {};
  } catch {
    return {};
  }
}

function renderOptions() {
  const box = $('#options');
  const saved = savedOptions(current.id);
  box.replaceChildren(
    ...current.options.map((opt) => {
      const wrap = el('label', 'opt');
      wrap.append(el('span', null, ts(opt.label)));
      const select = el('select');
      select.dataset.option = opt.id;
      for (const v of opt.values) {
        const o = el('option', null, ts(v.label));
        o.value = v.value;
        select.append(o);
      }
      const wanted = saved[opt.id];
      select.value = opt.values.some((v) => v.value === wanted) ? wanted : opt.default;
      select.addEventListener('change', () => store.set('opts-' + current.id, JSON.stringify(readOptions())));
      wrap.append(select);
      return wrap;
    }),
  );
  $('#format-hint').textContent = ts(current.hint || '');
}

function readOptions() {
  const out = {};
  document.querySelectorAll('#options select').forEach((s) => (out[s.dataset.option] = s.value));
  return out;
}

function renderFormats() {
  const saved = store.get('format', 'flac');
  current = formats.find((f) => f.id === saved) || formats[0];
  $('#formats').replaceChildren(
    ...formats.map((f) => {
      const label = el('label');
      const input = el('input');
      input.type = 'radio';
      input.name = 'format';
      input.value = f.id;
      input.checked = f === current;
      input.addEventListener('change', () => {
        current = f;
        store.set('format', f.id);
        renderOptions();
      });
      label.append(input, el('span', null, ts(f.label)));
      return label;
    }),
  );
  renderOptions();
}

// ---------- switches ----------
for (const [id, def] of [['lyrics', '1'], ['synced', '0'], ['normalize', '0'], ['auto', '1'], ['album', '0']]) {
  const box = $('#opt-' + id);
  box.checked = store.get('opt-' + id, def) === '1';
  box.addEventListener('change', () => store.set('opt-' + id, box.checked ? '1' : '0'));
}
// Synced lyrics only make sense when lyrics are wanted at all.
const syncLyricsRow = () => ($('#row-synced').hidden = !$('#opt-lyrics').checked);
$('#opt-lyrics').addEventListener('change', syncLyricsRow);
syncLyricsRow();

// ---------- the player ----------
// One audio element for the whole page. It plays the small preview the server
// makes next to each finished file, so every format can be heard in every
// browser, including after the file itself has been downloaded.
const player = new Audio();
player.preload = 'none';
let nowKey = null; // "job id/track index" of the track in the player

function stopPlayer() {
  player.pause();
  player.removeAttribute('src');
  nowKey = null;
  paintPlayer();
}

function togglePlay(key) {
  if (nowKey === key) {
    if (player.paused) player.play().catch(() => {});
    else player.pause();
    return;
  }
  nowKey = key;
  player.src = '/api/jobs/' + key.replace('/', '/preview/');
  player.play().catch(() => {});
  paintPlayer();
}

function paintSeek() {
  const row = document.querySelector('.track.current');
  if (!row) return;
  const total = player.duration;
  const fill = row.querySelector('.seek i');
  if (fill) fill.style.transform = 'scaleX(' + (total ? Math.min(1, player.currentTime / total) : 0) + ')';
  const time = row.querySelector('.seek-time');
  if (time) time.textContent = (fmtTime(player.currentTime) || '0:00') + (total && isFinite(total) ? ' / ' + fmtTime(total) : '');
}

// Volume: one setting for the whole page, remembered between visits. On
// phones where only the hardware buttons may change it (iOS), the control is
// left out.
const canSetVolume = (() => {
  const probe = new Audio();
  probe.volume = 0.5;
  return probe.volume === 0.5;
})();
let volume = parseFloat(store.get('volume', '1'));
if (!(volume >= 0 && volume <= 1)) volume = 1;
let muted = store.get('muted', '0') === '1';

function paintVolume() {
  player.volume = volume;
  player.muted = muted;
  const heard = muted ? 0 : volume;
  document.querySelectorAll('.volume').forEach((box) => {
    const range = box.querySelector('input');
    range.value = Math.round(heard * 100);
    range.style.setProperty('--fill', heard * 100 + '%');
    box.classList.toggle('silent', heard === 0);
    const label = t(heard === 0 ? 'unmute' : 'mute');
    const button = box.querySelector('button');
    button.title = label;
    button.setAttribute('aria-label', label);
  });
}

function setVolume(level, mute) {
  volume = Math.max(0, Math.min(1, level));
  muted = mute;
  store.set('volume', String(volume));
  store.set('muted', muted ? '1' : '0');
  paintVolume();
}

function volumeNode() {
  const box = el('div', 'volume');
  const button = el('button', 'ghost');
  button.type = 'button';
  button.append(icon('volume', 'when-loud'), icon('mute', 'when-silent'));
  // Silent (muted, or turned all the way down) -> heard again; otherwise mute.
  button.addEventListener('click', () => (muted || volume === 0 ? setVolume(volume || 0.5, false) : setVolume(volume, true)));
  const range = el('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.step = '1';
  range.setAttribute('aria-label', t('volume'));
  range.addEventListener('input', () => setVolume(range.value / 100, false));
  box.append(button, range);
  return box;
}

function paintPlayer() {
  document.querySelectorAll('.track[data-key]').forEach((row) => {
    const on = row.dataset.key === nowKey;
    const live = on && !player.paused;
    row.classList.toggle('current', on);
    row.classList.toggle('playing', live);
    const button = row.querySelector('.art-play');
    if (button) button.setAttribute('aria-label', t(live ? 'pause' : 'play'));
  });
  paintSeek();
  paintVolume();
}

for (const name of ['play', 'pause', 'ended', 'emptied']) player.addEventListener(name, paintPlayer);
player.addEventListener('timeupdate', paintSeek);
player.addEventListener('durationchange', paintSeek);
player.addEventListener('error', () => nowKey && stopPlayer());

// ---------- the tag editor ----------
// Opens under a finished track. The file's tags are written again on the
// server (the audio is copied, not converted a second time).
let editor = null; // { jobId, key, node }

function closeEditor(redraw) {
  if (!editor) return;
  const card = cards.get(editor.jobId);
  editor.node.remove();
  editor = null;
  if (card && redraw) card.sig = '';
}

function openEditor(job, index, track, row) {
  const key = job.id + '/' + index;
  if (editor && editor.key === key) return closeEditor(true);
  closeEditor(false);

  const m = track.meta || {};
  const start = {
    title: m.title || track.title || '',
    artist: m.artist || '',
    album: m.album || '',
    albumArtist: m.albumArtist || '',
    year: m.year ? String(m.year) : '',
    track: m.track ? String(m.track) : '',
    trackTotal: m.trackTotal ? String(m.trackTotal) : '',
    genre: m.genre || '',
  };
  const form = el('form', 'editor');
  form.noValidate = true;
  const inputs = {};
  const field = (name, cls, attrs) => {
    const label = el('label', 'ed ' + cls);
    label.append(el('span', null, t('f' + name[0].toUpperCase() + name.slice(1))));
    const input = el('input');
    input.type = 'text';
    input.value = start[name];
    input.autocomplete = 'off';
    input.spellcheck = false;
    Object.assign(input, attrs);
    inputs[name] = input;
    label.append(input);
    return label;
  };
  const numeric = { inputMode: 'numeric', maxLength: 4 };
  const trackOf = field('trackTotal', 'tiny', { ...numeric, maxLength: 3 });
  trackOf.firstChild.textContent = t('fOf');
  const grid = el('div', 'ed-grid');
  grid.append(
    field('title', 'wide', { maxLength: 200, required: true }),
    field('artist', 'half', { maxLength: 200 }),
    field('album', 'half', { maxLength: 200 }),
    field('albumArtist', 'half', { maxLength: 200 }),
    field('genre', 'half', { maxLength: 60 }),
    field('year', 'tiny', numeric),
    field('track', 'tiny', { ...numeric, maxLength: 3 }),
    trackOf,
  );

  const note = el('p', 'ed-note');
  note.hidden = true;
  const say = (text, bad) => {
    note.textContent = text || '';
    note.hidden = !text;
    note.classList.toggle('err', !!bad);
  };

  const file = el('input');
  file.type = 'file';
  file.accept = 'image/jpeg,image/png,image/webp';
  file.hidden = true;
  const find = el('button', 'quiet', t('findAgain'));
  find.type = 'button';
  const pick = el('button', 'quiet', t('chooseCover'));
  pick.type = 'button';
  const cancel = el('button', 'quiet', t('cancel'));
  cancel.type = 'button';
  const save = el('button', 'btn', t('save'));
  save.type = 'submit';
  const buttons = el('div', 'ed-buttons');
  const gap = el('span', 'ed-gap');
  buttons.append(find, pick, file, gap, cancel, save);
  form.append(grid, note, buttons);

  let suggested = false; // the last lookup found album art, kept on the server
  const busy = (on) => [find, pick, cancel, save].forEach((b) => (b.disabled = on));
  const where = '/api/jobs/' + job.id + '/tracks/' + index;

  pick.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const chosen = file.files[0];
    if (chosen && chosen.size > boot.limits.maxCoverBytes) {
      file.value = '';
      return say(t('coverTooBig', { mb: Math.round(boot.limits.maxCoverBytes / 1048576) }), true);
    }
    say(chosen ? t('coverChosen', { name: chosen.name }) : '');
  });
  cancel.addEventListener('click', () => {
    closeEditor(true);
    refresh();
  });

  find.addEventListener('click', async () => {
    busy(true);
    say(t('finding'));
    try {
      const found = await postJson(where + '/lookup', { title: inputs.title.value.trim(), artist: inputs.artist.value.trim() });
      for (const [name, input] of Object.entries(inputs)) input.value = found.tags[name] == null ? '' : String(found.tags[name]);
      suggested = found.cover;
      say(t('foundOn', { source: found.source }) + (found.cover ? ' ' + t('foundCover') : ''));
    } catch (err) {
      say(err.message, true);
    } finally {
      busy(false);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const now = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value.trim()]));
    const count = (v) => (/^\d{1,3}$/.test(v) && Number(v) > 0 ? Number(v) : null);
    const body = { ...now, year: /^\d{4}$/.test(now.year) ? now.year : '', track: count(now.track), trackTotal: count(now.trackTotal), suggestedCover: suggested && !file.files[0] };
    const changed = Object.keys(start).some((name) => start[name] !== now[name]) || body.suggestedCover;
    if (!changed && !file.files[0]) {
      closeEditor(true);
      return refresh();
    }
    busy(true);
    say(t('saving'));
    try {
      if (file.files[0]) await api(where + '/cover', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.files[0] });
      if (changed) await postJson(where, body, 'PATCH');
      closeEditor(true);
      toast(t('saved'));
      refresh();
    } catch (err) {
      busy(false);
      say(err.message, true);
    }
  });

  editor = { jobId: job.id, key, node: form };
  row.after(form);
  inputs.title.focus();
}

// ---------- job list ----------
const statusText = (tr) => (tr.status === 'downloading' ? t('downloading', { n: tr.progress }) : ['queued', 'tagging', 'converting'].includes(tr.status) ? t(tr.status) : '');

function trackNode(job, tr, i) {
  const key = job.id + '/' + i;
  const row = el('div', 'track');
  row.dataset.track = i;
  row.dataset.key = key;

  const art = el('div', 'art');
  if (tr.cover) {
    const img = el('img');
    img.src = '/api/jobs/' + job.id + '/cover/' + i + '?v=' + tr.cover;
    img.alt = '';
    art.append(img);
  } else {
    art.append(icon('note'));
  }
  if (tr.preview) {
    const play = el('button', 'art-play');
    play.type = 'button';
    play.append(icon('play', 'when-paused'), icon('pause', 'when-playing'));
    play.addEventListener('click', () => togglePlay(key));
    art.append(play);
  }
  row.append(art);

  const body = el('div', 'track-body');
  body.append(el('div', 'track-title', tr.title));
  const m = tr.meta;

  if (tr.status === 'error') {
    body.append(el('div', 'track-sub err', tr.error || t('trackError')));
  } else if (tr.status === 'collected') {
    const saved = el('div', 'track-sub saved');
    saved.append(icon('check'), t('collected'));
    body.append(saved);
  } else if (tr.status === 'done' && m) {
    const trackNo = m.track ? t('trackNo', { n: m.track + (m.trackTotal ? '/' + m.trackTotal : '') }) : null;
    body.append(el('div', 'track-sub', [m.artist, m.album, m.year, trackNo, m.genre].filter(Boolean).join(' · ') || t('noArtist')));
    const chips = el('div', 'chips');
    const add = (text, cls) => text && chips.append(el('span', 'chip' + (cls ? ' ' + cls : ''), text));
    const match = tr.match || {};
    add([m.container, m.codec].filter(Boolean).join(' / '));
    add(m.sampleRate && (m.sampleRate >= 1000000 ? (m.sampleRate / 1000000).toFixed(1) + ' MHz' : m.sampleRate / 1000 + ' kHz'));
    add(m.bitsPerSample && m.bitsPerSample + '-bit');
    add(fmtTime(m.duration));
    add(fmtSize(tr.size));
    if (match.edited) add(t('edited'), 'ok');
    else add(match.matched ? t('matchedOn', { source: match.source }) : match.lookupFailed ? t('lookupFailed') : t('noMatch'), match.matched ? 'ok' : 'warn');
    add(match.fullFrom ? t('fullFrom', { source: match.fullFrom }) : null);
    add(m.cover ? t('artwork') : null, 'ok');
    add(m.lyrics ? t(tr.lrc ? 'syncedLyrics' : 'lyrics') : null, 'ok');
    add(tr.gain ? t('levelled', { db: (tr.gain > 0 ? '+' : '−') + Math.abs(tr.gain).toFixed(1) }) : null);
    body.append(chips);
  } else {
    body.append(el('div', 'track-sub pct', statusText(tr)));
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = tr.progress + '%';
    bar.append(fill);
    body.append(bar);
  }
  if (tr.preview) {
    // Shown only for the track in the player: where it is, and click to jump.
    const seekRow = el('div', 'seek-row');
    const seek = el('div', 'seek');
    seek.append(el('i'));
    seek.addEventListener('click', (e) => {
      const box = seek.getBoundingClientRect();
      if (nowKey === key && player.duration) player.currentTime = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * player.duration;
    });
    seekRow.append(seek, el('span', 'seek-time'));
    if (canSetVolume) seekRow.append(volumeNode());
    body.append(seekRow);
  }
  row.append(body);

  const actions = el('div', 'track-actions');
  if (tr.editable) {
    const edit = el('button', 'ghost');
    edit.type = 'button';
    edit.title = t('edit');
    edit.setAttribute('aria-label', t('edit'));
    edit.append(icon('pen'));
    edit.addEventListener('click', () => openEditor(job, i, tr, row));
    actions.append(edit);
  }
  if (tr.lrc) {
    const lrc = el('a', 'ghost');
    lrc.href = '/api/jobs/' + job.id + '/lrc/' + i;
    lrc.setAttribute('download', '');
    lrc.title = t('lrc');
    lrc.setAttribute('aria-label', t('lrc'));
    lrc.append(icon('lines'));
    actions.append(lrc);
  }
  if (tr.ready) {
    const a = el('a', 'btn');
    a.href = '/api/jobs/' + job.id + '/files/' + i;
    a.setAttribute('download', '');
    a.append(icon('down'), t('download'));
    actions.append(a);
  }
  if (actions.childElementCount) row.append(actions);
  return row;
}

function jobContent(job) {
  const head = el('div', 'job-head');
  head.append(el('div', 'job-title', job.title), el('span', 'badge', job.format));
  if (job.tracks.filter((tr) => tr.ready).length > 1) {
    const zip = el('a', 'btn');
    zip.href = '/api/jobs/' + job.id + '/zip';
    zip.setAttribute('download', '');
    zip.append(icon('down'), t('downloadAll'));
    head.append(zip);
  }
  const rm = el('button', 'ghost');
  rm.type = 'button';
  rm.setAttribute('aria-label', t('remove'));
  rm.title = t('remove');
  rm.append(icon('x'));
  rm.addEventListener('click', async () => {
    await api('/api/jobs/' + job.id, { method: 'DELETE' }).catch(() => {});
    refresh();
  });
  head.append(rm);

  const out = [head];
  if (!job.tracks.length) {
    out.push(el('div', 'job-note' + (job.status === 'error' ? ' err' : ''), job.status === 'error' ? job.error : job.status === 'queued' ? t('inQueue') : t('looking')));
  }
  job.tracks.forEach((tr, i) => out.push(trackNode(job, tr, i)));
  if (job.expiresAt && job.tracks.some((tr) => tr.ready)) out.push(el('div', 'job-note expiry'));
  return out;
}

const cards = new Map(); // job id -> { node, sig }

function syncJobs(jobs) {
  const list = $('#jobs');
  const seen = new Set();
  jobs.forEach((job, index) => {
    seen.add(job.id);
    // Everything except the moving progress numbers decides whether to redraw.
    const sig = JSON.stringify({ ...job, tracks: job.tracks.map((tr) => ({ ...tr, progress: 0 })) });
    let card = cards.get(job.id);
    if (!card) {
      card = { node: el('article', 'job enter'), sig: '' };
      cards.set(job.id, card);
    }
    // A card with the tag editor open is left alone until the editor closes.
    if (card.sig !== sig && !(editor && editor.jobId === job.id)) {
      card.sig = sig;
      card.node.replaceChildren(...jobContent(job));
    }
    job.tracks.forEach((tr, i) => {
      const row = card.node.querySelector('[data-track="' + i + '"]');
      const fill = row && row.querySelector('.bar i');
      if (fill) fill.style.width = tr.progress + '%';
      const pct = row && row.querySelector('.pct');
      if (pct) pct.textContent = statusText(tr);
    });
    const expiry = card.node.querySelector('.expiry');
    if (expiry) {
      const mins = Math.max(0, Math.ceil((job.expiresAt - Date.now()) / 60000));
      expiry.textContent = mins > 1 ? t('expiry', { n: mins }) : t('expirySoon');
    }
    if (list.children[index] !== card.node) list.insertBefore(card.node, list.children[index] || null);
  });
  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    cards.delete(id);
    if (editor && editor.jobId === id) editor = null;
    if (nowKey && nowKey.startsWith(id + '/')) stopPlayer();
    card.node.classList.add('leave');
    setTimeout(() => card.node.remove(), 260);
  }
  $('#empty').hidden = jobs.length > 0;
  paintPlayer();
}

let usage = null;
function syncMeter(next) {
  usage = next;
  const pct = Math.min(100, (usage.used / usage.quota) * 100);
  $('#meter-text').textContent = t('meter', { used: usage.used ? fmtSize(usage.used) : '0', quota: fmtGb(usage.quota) });
  $('#meter-fill').style.width = pct + '%';
  $('#meter').classList.toggle('full', pct >= 100);
}

// Jobs started from this tab are saved by the browser as soon as they finish:
// the single file, or one zip holding the whole playlist.
const mine = new Set();
function autoDownload(jobs) {
  for (const job of jobs) {
    if (!mine.has(job.id) || (job.status !== 'done' && job.status !== 'error')) continue;
    mine.delete(job.id);
    const ready = job.tracks.map((tr, i) => (tr.ready ? i : -1)).filter((i) => i >= 0);
    if (!ready.length || !$('#opt-auto').checked) continue;
    const a = el('a');
    a.href = ready.length > 1 ? '/api/jobs/' + job.id + '/zip' : '/api/jobs/' + job.id + '/files/' + ready[0];
    a.setAttribute('download', '');
    document.body.append(a);
    a.click();
    a.remove();
    toast(ready.length > 1 ? t('toastPlaylist') : t('toastSong'));
  }
}

// The official album art of finished songs joins the tiles drifting behind
// the glass (backdrop.js). Video thumbnails are left out. Oldest job first, so
// the newest song ends up at the front.
function collectCovers(jobs) {
  for (const job of [...jobs].reverse()) {
    job.tracks.forEach((tr, i) => {
      if (!tr.cover || !tr.meta || (tr.status !== 'done' && tr.status !== 'collected')) return;
      if (!/album art$/.test((tr.match && tr.match.cover) || '')) return;
      const album = [tr.meta.artist, tr.meta.album || tr.title].join(' | ').toLowerCase();
      window.backdrop.remember(job.id + '/' + i + '/' + tr.cover, album, '/api/jobs/' + job.id + '/cover/' + i + '?v=' + tr.cover);
    });
  }
}

let timer;
async function refresh() {
  clearTimeout(timer);
  let busy = false;
  try {
    // Naming the job being listened to keeps it on the server while it plays.
    const listening = nowKey && !player.paused ? '?playing=' + nowKey.split('/')[0] : '';
    const data = await api('/api/jobs' + listening);
    syncJobs(data.jobs);
    syncMeter(data.usage);
    autoDownload(data.jobs);
    collectCovers(data.jobs);
    busy = data.jobs.some((j) => j.status === 'queued' || j.status === 'running');
    $('#eq').classList.toggle('live', busy);
  } catch (err) {
    if (err.locked) return showLock();
  }
  timer = setTimeout(refresh, busy ? 1500 : 5000);
}

// ---------- links, several links, or a song name ----------
const LINK = /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com|soundcloud\.com)\/\S/i;

/** What was typed: one or more links, or words to search for. */
function readInput(text) {
  const links = text
    .split(/\s+/)
    .filter((w) => LINK.test(w))
    .map((w) => (/^https?:\/\//i.test(w) ? w : 'https://' + w));
  return links.length ? { links: [...new Set(links)] } : { query: text.trim().replace(/\s+/g, ' ') };
}

const input = $('#url');
const paintButton = () => ($('#go-text').textContent = t(input.value.trim() && !readInput(input.value).links ? 'goSearch' : 'go'));
input.addEventListener('input', () => {
  paintButton();
  showAlert('#alert', '');
});
// A single-line field drops line breaks, which would glue pasted links
// together. Turn them into spaces instead.
input.addEventListener('paste', (e) => {
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (!text || !/[\r\n]/.test(text)) return;
  e.preventDefault();
  const clean = text.split(/\s+/).filter(Boolean).join(' ');
  input.setRangeText(clean, input.selectionStart, input.selectionEnd, 'end');
  paintButton();
});

function hideResults() {
  $('#results').hidden = true;
  $('#results').replaceChildren();
}

async function startJob(urls) {
  const body = {
    format: current.id,
    options: readOptions(),
    album: $('#opt-album').checked,
    lyrics: $('#opt-lyrics').checked,
    synced: $('#opt-lyrics').checked && $('#opt-synced').checked,
    normalize: $('#opt-normalize').checked,
  };
  if (urls.length > 1) body.urls = urls;
  else body.url = urls[0];
  const job = await postJson('/api/jobs', body);
  mine.add(job.id);
  input.value = '';
  paintButton();
  hideResults();
  document.querySelector('.tab[data-tab="music"]').click();
  refresh();
}

async function search(query) {
  const box = $('#results');
  box.hidden = false;
  box.replaceChildren(el('p', 'results-note', t('searching')));
  const { results } = await api('/api/search?q=' + encodeURIComponent(query));
  if (!results.length) return box.replaceChildren(el('p', 'results-note', t('noResults')));
  const head = el('div', 'results-head');
  const close = el('button', 'ghost');
  close.type = 'button';
  close.setAttribute('aria-label', t('close'));
  close.append(icon('x'));
  close.addEventListener('click', hideResults);
  head.append(el('span', null, t('pick')), close);
  box.replaceChildren(
    head,
    ...results.map((r) => {
      const item = el('button', 'result');
      item.type = 'button';
      item.append(el('span', 'result-title', r.title), el('span', 'result-sub', [r.by, fmtTime(r.duration)].filter(Boolean).join(' · ')));
      item.addEventListener('click', async () => {
        box.querySelectorAll('button').forEach((b) => (b.disabled = true));
        try {
          await startJob([r.url]);
        } catch (err) {
          showAlert('#alert', err.message);
          box.querySelectorAll('button').forEach((b) => (b.disabled = false));
        }
      });
      return item;
    }),
  );
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAlert('#alert', '');
  const typed = readInput(input.value);
  if (!typed.links && !typed.query) return showAlert('#alert', t('needLink'));
  if (typed.links && typed.links.length > boot.limits.maxLinks) return showAlert('#alert', t('tooManyLinks', { n: boot.limits.maxLinks }));
  const btn = $('#go');
  btn.disabled = true;
  try {
    if (typed.links) await startJob(typed.links);
    else await search(typed.query.slice(0, 100));
  } catch (err) {
    hideResults();
    showAlert('#alert', err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- inspector ----------
function showInspect(name, d) {
  const head = el('div', 'insp-head');
  if (d.picture && d.picture.dataUrl) {
    const img = el('img');
    img.src = d.picture.dataUrl;
    img.alt = t('embeddedArt');
    head.append(img);
  }
  const info = el('div');
  info.append(el('div', 'track-title', d.tags.title || name), el('div', 'track-sub', [d.tags.artist, d.tags.album, d.tags.year].filter(Boolean).join(' · ')));
  head.append(info);

  const table = el('table', 'kv');
  const section = (title) => {
    const tr = el('tr', 'sec');
    const td = el('td', null, title);
    td.colSpan = 2;
    tr.append(td);
    table.append(tr);
  };
  const row = (k, v) => {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
    if (Array.isArray(v)) v = v.join(', ');
    else if (typeof v === 'object') v = Object.entries(v).filter(([, x]) => x != null).map(([a, b]) => a + ' ' + b).join(', ');
    if (v === '') return;
    const tr = el('tr');
    tr.append(el('td', null, k), el('td', null, String(v)));
    table.append(tr);
  };
  const f = d.format;
  section(t('secAudio'));
  row(t('container'), f.container);
  row(t('codec'), f.codec);
  row(t('lossless'), f.lossless == null ? null : t(f.lossless ? 'yes' : 'no'));
  row(t('sampleRate'), f.sampleRate && f.sampleRate + ' Hz');
  row(t('bitDepth'), f.bitsPerSample && f.bitsPerSample + '-bit');
  row(t('channels'), f.numberOfChannels);
  row(t('bitrate'), f.bitrate && Math.round(f.bitrate / 1000) + ' kbps');
  row(t('duration'), fmtTime(f.duration));
  row(t('tagFormats'), f.tagTypes);
  row(t('artworkRow'), d.picture ? d.picture.format + ', ' + fmtSize(d.picture.bytes) : t('none'));
  section(t('secTags'));
  for (const [k, v] of Object.entries(d.tags)) row(k, v);
  for (const [type, list] of Object.entries(d.raw || {})) {
    if (!list.length) continue;
    section(t('secRaw', { type }));
    for (const item of list) row(item.id, item.value);
  }
  $('#inspect-out').replaceChildren(head, table);
}

// The kinds of file this server's inspector accepts (set by its administrator).
// Checking the name and size here only saves a pointless upload: the server
// decides for itself, from the file's bytes.
const inspectKinds = () => boot.inspectTypes.map((k) => k.label).join(', ');

async function inspectFile(file) {
  if (!file) return;
  const out = $('#inspect-out');
  const ending = (/\.([A-Za-z0-9]{1,5})$/.exec(file.name) || [])[1];
  if (!ending || !boot.inspectTypes.some((k) => k.ext.includes(ending.toLowerCase()))) {
    return out.replaceChildren(el('div', 'alert', t('inspectKind', { types: inspectKinds() })));
  }
  if (file.size > boot.limits.maxUploadBytes) {
    return out.replaceChildren(el('div', 'alert', t('inspectBig', { mb: Math.round(boot.limits.maxUploadBytes / 1048576) })));
  }
  out.replaceChildren(el('p', 'job-note', t('reading', { name: file.name })));
  try {
    showInspect(file.name, await api('/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }));
  } catch (err) {
    out.replaceChildren(el('div', 'alert', err.message));
  }
}
{
  const drop = $('#drop');
  const file = $('#file');
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file.click();
    }
  });
  file.addEventListener('change', () => {
    inspectFile(file.files[0]);
    file.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    inspectFile(e.dataTransfer.files[0]);
  });
}

// ---------- password screen (only when the server has one set) ----------
function showLock() {
  $('#lock').hidden = false;
  $('#lock-pass').focus();
}
$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAlert('#lock-alert', '');
  try {
    await postJson('/api/login', { password: $('#lock-pass').value });
    $('#lock-pass').value = '';
    $('#lock').hidden = true;
    refresh();
  } catch (err) {
    showAlert('#lock-alert', err.message);
  }
});

// ---------- language ----------
function paintStatic() {
  greet();
  paintButton();
  if (!boot) return;
  $('#fineprint').textContent =
    t('fineprint', { min: boot.limits.ttlMinutes, gb: fmtGb(boot.limits.quotaBytes) }) + ' ' + t('sitesNote', { sites: boot.sites.join(', ') });
  $('#inspect-text').textContent = t('inspectText', { types: inspectKinds() });
  renderFormats();
  if (usage) syncMeter(usage);
}
{
  const select = $('#lang');
  for (const [code, name] of Object.entries(window.i18n.names)) {
    const o = el('option', null, name);
    o.value = code;
    select.append(o);
  }
  select.value = window.i18n.lang;
  select.addEventListener('change', () => {
    window.i18n.set(select.value);
    paintStatic();
    closeEditor(false);
    for (const card of cards.values()) card.sig = ''; // redraw every card in the new language
    refresh();
  });
}

// ---------- a link handed over by another app ----------
// Installed as an app, Mixdown appears in the phone's Share menu (see
// manifest.webmanifest): the shared text arrives in the address. It is only
// placed in the field. Nothing starts until the visitor presses the button,
// so a link to this page can never start a download on someone's behalf.
function takeSharedLink() {
  const params = new URLSearchParams(location.search);
  const shared = ['url', 'text', 'title'].map((k) => params.get(k) || '').join(' ').slice(0, 4000);
  if (!params.has('url') && !params.has('text') && !params.has('title')) return;
  history.replaceState(null, '', location.pathname);
  const typed = readInput(shared);
  if (!typed.links) return;
  input.value = typed.links.slice(0, boot.limits.maxLinks).join(' ');
  paintButton();
  toast(t('shared'));
}

// ---------- start ----------
(async () => {
  try {
    boot = await api('/api/bootstrap');
  } catch {
    return showAlert('#alert', t('noServer'));
  }
  formats = boot.formats;
  paintStatic();

  $('#credit-name').textContent = boot.credits.name;
  $('#credit-github').href = boot.credits.github;
  $('#credit-website').href = boot.credits.website;
  syncMeter({ used: 0, quota: boot.limits.quotaBytes });
  // The inspector: only the file kinds this server accepts can be picked, and
  // its tab is gone when the server has it switched off.
  $('#file').accept = boot.inspectTypes.flatMap((k) => k.ext.map((e) => '.' + e)).join(',');
  document.querySelector('.tab[data-tab="inspect"]').hidden = !boot.features.inspect;
  takeSharedLink();

  if (!boot.ready) showAlert('#alert', t('missingTools'));
  if (boot.locked && !boot.unlocked) return showLock();
  refresh();
})();

// Lets the browser offer "Install", and opens the page shell when offline.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
