'use strict';

// ---------- tiny helpers ----------
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
const fmtTime = (s) => (s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '');

async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.locked = !!data.locked;
    throw err;
  }
  return data;
}

function toast(message, bad) {
  const t = el('div', 'toast' + (bad ? ' bad' : ''), message);
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
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
(() => {
  const h = new Date().getHours();
  const hello = h < 5 ? 'Up late?' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
  $('#greet').textContent = hello + ' What are we listening to?';
})();

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
      $('#panel-' + t.dataset.tab).hidden = !on;
    });
  });
});

// ---------- formats and their options ----------
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
      wrap.append(el('span', null, opt.label));
      const select = el('select');
      select.dataset.option = opt.id;
      for (const v of opt.values) {
        const o = el('option', null, v.label);
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
  $('#format-hint').textContent = current.hint || '';
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
      label.append(input, el('span', null, f.label));
      return label;
    }),
  );
  renderOptions();
}

// ---------- switches ----------
for (const [id, def] of [['lyrics', '1'], ['auto', '1'], ['album', '0']]) {
  const box = $('#opt-' + id);
  box.checked = store.get('opt-' + id, def) === '1';
  box.addEventListener('change', () => store.set('opt-' + id, box.checked ? '1' : '0'));
}

// ---------- job list ----------
const WORKING = { queued: 'Waiting for its turn…', tagging: 'Finding the album, artwork and lyrics…', converting: 'Converting and tagging…' };
const statusText = (t) => (t.status === 'downloading' ? 'Fetching the audio… ' + t.progress + '%' : WORKING[t.status] || '');

function trackNode(job, t, i) {
  const row = el('div', 'track');
  row.dataset.track = i;

  const art = el('div', 'art');
  if (t.cover) {
    const img = el('img');
    img.src = '/api/jobs/' + job.id + '/cover/' + i;
    img.alt = '';
    art.append(img);
  } else {
    art.append(icon('note'));
  }
  row.append(art);

  const body = el('div', 'track-body');
  body.append(el('div', 'track-title', t.title));
  const m = t.meta;

  if (t.status === 'error') {
    body.append(el('div', 'track-sub err', t.error || 'That one did not work.'));
  } else if (t.status === 'collected') {
    const saved = el('div', 'track-sub saved');
    saved.append(icon('check'), 'Downloaded and removed from the server');
    body.append(saved);
  } else if (t.status === 'done' && m) {
    const trackNo = m.track ? 'track ' + m.track + (m.trackTotal ? '/' + m.trackTotal : '') : null;
    body.append(el('div', 'track-sub', [m.artist, m.album, m.year, trackNo, m.genre].filter(Boolean).join(' · ') || 'No artist found'));
    const chips = el('div', 'chips');
    const add = (text, cls) => text && chips.append(el('span', 'chip' + (cls ? ' ' + cls : ''), text));
    const matched = t.match && t.match.source !== 'YouTube';
    add([m.container, m.codec].filter(Boolean).join(' / '));
    add(m.sampleRate && (m.sampleRate >= 1000000 ? (m.sampleRate / 1000000).toFixed(1) + ' MHz' : m.sampleRate / 1000 + ' kHz'));
    add(m.bitsPerSample && m.bitsPerSample + '-bit');
    add(fmtTime(m.duration));
    add(fmtSize(t.size));
    add(matched ? 'matched on ' + t.match.source : t.match && t.match.lookupFailed ? 'lookup failed, try again' : 'no catalogue match', matched ? 'ok' : 'warn');
    add(m.cover ? 'artwork' : null, 'ok');
    add(m.lyrics ? 'lyrics' : null, 'ok');
    body.append(chips);
  } else {
    body.append(el('div', 'track-sub pct', statusText(t)));
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = t.progress + '%';
    bar.append(fill);
    body.append(bar);
  }
  row.append(body);

  if (t.ready) {
    const a = el('a', 'btn');
    a.href = '/api/jobs/' + job.id + '/files/' + i;
    a.setAttribute('download', '');
    a.append(icon('down'), 'Download');
    row.append(a);
  }
  return row;
}

function jobContent(job) {
  const head = el('div', 'job-head');
  head.append(el('div', 'job-title', job.title), el('span', 'badge', job.format));
  if (job.tracks.filter((t) => t.ready).length > 1) {
    const zip = el('a', 'btn');
    zip.href = '/api/jobs/' + job.id + '/zip';
    zip.setAttribute('download', '');
    zip.append(icon('down'), 'Download all');
    head.append(zip);
  }
  const rm = el('button', 'ghost');
  rm.type = 'button';
  rm.setAttribute('aria-label', 'Remove');
  rm.title = 'Remove';
  rm.append(icon('x'));
  rm.addEventListener('click', async () => {
    await api('/api/jobs/' + job.id, { method: 'DELETE' }).catch(() => {});
    refresh();
  });
  head.append(rm);

  const out = [head];
  if (!job.tracks.length) {
    out.push(el('div', 'job-note' + (job.status === 'error' ? ' err' : ''), job.status === 'error' ? job.error : job.status === 'queued' ? 'In the queue…' : 'Taking a look at your link…'));
  }
  job.tracks.forEach((t, i) => out.push(trackNode(job, t, i)));
  if (job.expiresAt && job.tracks.some((t) => t.ready)) out.push(el('div', 'job-note expiry'));
  return out;
}

const cards = new Map(); // job id -> { node, sig }

function syncJobs(jobs) {
  const list = $('#jobs');
  const seen = new Set();
  jobs.forEach((job, index) => {
    seen.add(job.id);
    // Everything except the moving progress numbers decides whether to redraw.
    const sig = JSON.stringify({ ...job, tracks: job.tracks.map((t) => ({ ...t, progress: 0 })) });
    let card = cards.get(job.id);
    if (!card) {
      card = { node: el('article', 'job enter'), sig: '' };
      cards.set(job.id, card);
    }
    if (card.sig !== sig) {
      card.sig = sig;
      card.node.replaceChildren(...jobContent(job));
    }
    job.tracks.forEach((t, i) => {
      const row = card.node.querySelector('[data-track="' + i + '"]');
      const fill = row && row.querySelector('.bar i');
      if (fill) fill.style.width = t.progress + '%';
      const pct = row && row.querySelector('.pct');
      if (pct) pct.textContent = statusText(t);
    });
    const expiry = card.node.querySelector('.expiry');
    if (expiry) {
      const mins = Math.max(0, Math.ceil((job.expiresAt - Date.now()) / 60000));
      expiry.textContent = mins > 1 ? 'Waiting for you for ' + mins + ' more minutes.' : 'About to be cleared. Grab it now.';
    }
    if (list.children[index] !== card.node) list.insertBefore(card.node, list.children[index] || null);
  });
  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    cards.delete(id);
    card.node.classList.add('leave');
    setTimeout(() => card.node.remove(), 260);
  }
  $('#empty').hidden = jobs.length > 0;
}

function syncMeter(usage) {
  const pct = Math.min(100, (usage.used / usage.quota) * 100);
  $('#meter-text').textContent = (usage.used ? fmtSize(usage.used) : '0') + ' of ' + fmtGb(usage.quota) + ' GB waiting';
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
    const ready = job.tracks.map((t, i) => (t.ready ? i : -1)).filter((i) => i >= 0);
    if (!ready.length || !$('#opt-auto').checked) continue;
    const a = el('a');
    a.href = ready.length > 1 ? '/api/jobs/' + job.id + '/zip' : '/api/jobs/' + job.id + '/files/' + ready[0];
    a.setAttribute('download', '');
    document.body.append(a);
    a.click();
    a.remove();
    toast(ready.length > 1 ? 'Your playlist is on its way.' : 'Your song is on its way.');
  }
}

let timer;
async function refresh() {
  clearTimeout(timer);
  let busy = false;
  try {
    const data = await api('/api/jobs');
    syncJobs(data.jobs);
    syncMeter(data.usage);
    autoDownload(data.jobs);
    busy = data.jobs.some((j) => j.status === 'queued' || j.status === 'running');
    $('#eq').classList.toggle('live', busy);
  } catch (err) {
    if (err.locked) return showLock();
  }
  timer = setTimeout(refresh, busy ? 1500 : 5000);
}

// ---------- submit ----------
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAlert('#alert', '');
  const url = $('#url').value.trim();
  if (!url) return showAlert('#alert', 'Paste a YouTube link first.');
  const btn = $('#go');
  btn.disabled = true;
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: current.id, options: readOptions(), album: $('#opt-album').checked, lyrics: $('#opt-lyrics').checked }),
    });
    mine.add(job.id);
    $('#url').value = '';
    document.querySelector('.tab[data-tab="music"]').click();
    refresh();
  } catch (err) {
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
    img.alt = 'Embedded artwork';
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
  section('Audio');
  row('Container', f.container);
  row('Codec', f.codec);
  row('Lossless', f.lossless == null ? null : f.lossless ? 'yes' : 'no');
  row('Sample rate', f.sampleRate && f.sampleRate + ' Hz');
  row('Bit depth', f.bitsPerSample && f.bitsPerSample + '-bit');
  row('Channels', f.numberOfChannels);
  row('Bitrate', f.bitrate && Math.round(f.bitrate / 1000) + ' kbps');
  row('Duration', fmtTime(f.duration));
  row('Tag formats', f.tagTypes);
  row('Artwork', d.picture ? d.picture.format + ', ' + fmtSize(d.picture.bytes) : 'none');
  section('Tags');
  for (const [k, v] of Object.entries(d.tags)) row(k, v);
  for (const [type, list] of Object.entries(d.raw || {})) {
    if (!list.length) continue;
    section('Raw ' + type);
    for (const t of list) row(t.id, t.value);
  }
  $('#inspect-out').replaceChildren(head, table);
}

async function inspectFile(file) {
  if (!file) return;
  const out = $('#inspect-out');
  out.replaceChildren(el('p', 'job-note', 'Reading ' + file.name + '…'));
  try {
    showInspect(file.name, await api('/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }));
  } catch (err) {
    out.replaceChildren(el('div', 'alert', err.message));
  }
}
{
  const drop = $('#drop');
  const input = $('#file');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    inspectFile(input.files[0]);
    input.value = '';
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
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#lock-pass').value }) });
    $('#lock-pass').value = '';
    $('#lock').hidden = true;
    refresh();
  } catch (err) {
    showAlert('#lock-alert', err.message);
  }
});

// ---------- start ----------
(async () => {
  let boot;
  try {
    boot = await api('/api/bootstrap');
  } catch {
    return showAlert('#alert', "I can't reach the server right now. Refresh in a moment.");
  }
  formats = boot.formats;
  renderFormats();

  $('#credit-name').textContent = boot.credits.name;
  $('#credit-github').href = boot.credits.github;
  $('#credit-website').href = boot.credits.website;
  $('#fineprint').textContent =
    'Finished files wait for you for ' + boot.limits.ttlMinutes + ' minutes and are deleted from the server the moment you download them. ' +
    'You can have up to ' + fmtGb(boot.limits.quotaBytes) + ' GB waiting at a time; download and the space is yours again.';
  syncMeter({ used: 0, quota: boot.limits.quotaBytes });

  if (!boot.ready) showAlert('#alert', 'The server is missing yt-dlp or ffmpeg, so downloads will not work yet.');
  if (boot.locked && !boot.unlocked) return showLock();
  refresh();
})();
