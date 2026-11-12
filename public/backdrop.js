'use strict';

// Album art drifting behind the glass, like dust in a sunbeam.
//
// The artwork of the last songs fetched in this browser floats through a 3D
// space behind the interface: each tile wanders along its own random curved
// path, tumbling as it goes, fades out, and comes back somewhere else with
// another cover. The
// tiles are blurred and very dim, so they add depth without getting in the way.
//
// The covers are kept in this browser only (localStorage, as small JPEGs); the
// server still deletes everything once a song has been downloaded. Each tile
// is one animation of transform and opacity, so the browser runs it on the
// compositor and no script runs between two respawns.
window.backdrop = (() => {
  const KEY = 'covers';
  const MAX_COVERS = 18;
  const PERSPECTIVE = 1000; // px, must match .motes in style.css
  const FAR = -820;
  const NEAR = 240;
  const LEGS = 4; // stretches of the random walk in one life of a tile
  const STEPS = 5; // keyframes per stretch, enough for the curve to look smooth
  const FADE = 0.15; // share of its life a tile spends fading in, and again fading out

  const box = document.getElementById('motes');
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------- saved covers, newest first: [{ k: album key, d: data URL }] ----------
  const valid = (c) => c && typeof c.k === 'string' && typeof c.d === 'string' && c.d.startsWith('data:image/jpeg;base64,') && c.d.length < 200000;
  let covers = [];
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(saved)) covers = saved.filter(valid).slice(0, MAX_COVERS);
  } catch {
    /* storage unavailable or damaged: start empty */
  }

  function save() {
    // If the browser has no room, keep fewer covers rather than none.
    for (let keep = covers.length; keep > 0; keep = Math.floor(keep / 2)) {
      try {
        localStorage.setItem(KEY, JSON.stringify(covers.slice(0, keep)));
        return;
      } catch {
        /* try again with half */
      }
    }
  }

  const seen = new Set(); // tracks already looked at on this page
  const loading = new Set(); // album keys being fetched right now

  /**
   * Remember the artwork of a finished song. `id` names the track, `key` names
   * its album (ten songs from one album give one tile, not ten), and `url` is
   * where the small cover can be read.
   */
  async function remember(id, key, url) {
    if (!box || seen.has(id)) return;
    seen.add(id);
    const at = covers.findIndex((c) => c.k === key);
    if (at === 0 || loading.has(key)) return;
    if (at > 0) {
      covers.unshift(covers.splice(at, 1)[0]); // fetched again: it is the newest now
      return save();
    }
    loading.add(key);
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('no cover');
      const blob = await res.blob();
      if (blob.type !== 'image/jpeg' || blob.size > 140000) return;
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const cover = { k: key, d: data };
      if (!valid(cover)) return;
      covers.unshift(cover);
      covers.length = Math.min(covers.length, MAX_COVERS);
      save();
    } catch {
      seen.delete(id); // try again on the next refresh
    } finally {
      loading.delete(key);
    }
  }

  if (!box) return { remember };

  // ---------- tiles ----------
  const tiles = [];

  /** A cover that is not on screen too often already, or null for an empty tile. */
  function pickCover(self) {
    const shown = new Map();
    for (const t of tiles) if (t !== self && t.key) shown.set(t.key, (shown.get(t.key) || 0) + 1);
    const most = covers.length * 2 < tiles.length ? 2 : 1;
    const free = covers.filter((c) => (shown.get(c.k) || 0) < most);
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }

  // A page opened in the background can report a width of 0 until it is shown.
  const wanted = () => {
    const w = window.innerWidth || 1280;
    return w < 700 ? 7 : w < 1200 ? 10 : 14;
  };

  function spawn(tile, startAt) {
    if (tiles.length > wanted()) {
      // The window got smaller: this tile does not come back.
      tiles.splice(tiles.indexOf(tile), 1);
      return tile.node.remove();
    }
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    const size = Math.round(clamp(Math.min(w, h) * rand(0.14, 0.25), 84, 230));

    // A random walk: a few waypoints, each a step in a new direction from the
    // one before, with its own depth and tilt. x and y are spots on screen.
    const step = Math.min(w, h);
    const path = [{ x: rand(-0.56, 0.56) * w, y: rand(-0.56, 0.56) * h, z: rand(FAR, NEAR), rx: rand(-40, 40), ry: rand(-40, 40), rz: rand(-25, 25) }];
    for (let i = 1; i <= LEGS; i++) {
      const p = path[i - 1];
      const angle = rand(0, Math.PI * 2);
      const far = rand(0.22, 0.42) * step;
      path.push({
        x: clamp(p.x + Math.cos(angle) * far, -0.62 * w, 0.62 * w),
        y: clamp(p.y + Math.sin(angle) * far, -0.62 * h, 0.62 * h),
        z: clamp(p.z + rand(-320, 320), FAR, NEAR),
        rx: rand(-40, 40),
        ry: rand(-40, 40),
        rz: p.rz + rand(-35, 35),
      });
    }

    // Closer tiles are larger, softer and fainter, like dust near the eye.
    const nearness = (path.reduce((sum, p) => sum + p.z, 0) / path.length - FAR) / (NEAR - FAR);
    const peak = 1 - nearness * 0.4;

    // The waypoints are joined by a smooth curve (Catmull-Rom) and the curve is
    // handed to the browser as closely spaced keyframes, so the tile swerves
    // from one heading to the next without ever stopping at a corner.
    const curve = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
    const frames = [];
    const total = LEGS * STEPS;
    for (let n = 0; n <= total; n++) {
      const leg = Math.min(LEGS - 1, Math.floor(n / STEPS));
      const t = n / STEPS - leg;
      const at = (key) => curve(path[Math.max(0, leg - 1)][key], path[leg][key], path[leg + 1][key], path[Math.min(LEGS, leg + 2)][key], t);
      const z = clamp(at('z'), FAR, NEAR);
      // Dividing by the perspective scale puts the tile where it will be seen.
      const k = (PERSPECTIVE - z) / PERSPECTIVE;
      const life = n / total;
      frames.push({
        transform: `translate3d(${(at('x') * k).toFixed(1)}px, ${(at('y') * k).toFixed(1)}px, ${z.toFixed(1)}px) rotateX(${at('rx').toFixed(1)}deg) rotateY(${at('ry').toFixed(1)}deg) rotateZ(${at('rz').toFixed(1)}deg)`,
        opacity: +(peak * Math.min(1, life / FADE, (1 - life) / FADE)).toFixed(3),
      });
    }
    const node = tile.node;
    node.style.width = node.style.height = size + 'px';
    node.style.margin = -size / 2 + 'px';
    node.style.filter = `blur(${(1.5 + nearness * 5.5).toFixed(1)}px)`;

    const cover = pickCover(tile);
    tile.key = cover ? cover.k : null;
    node.classList.toggle('blank', !cover);
    if (cover) tile.img.src = cover.d;
    else tile.img.removeAttribute('src');

    if (tile.anim) tile.anim.cancel();
    if (calm) {
      // Less motion was asked for: the tiles stay where they are.
      node.style.transform = frames[Math.round(total / 2)].transform;
      node.style.opacity = peak;
      return;
    }
    const duration = rand(18000, 30000);
    tile.anim = node.animate(frames, { duration, easing: 'linear' });
    if (startAt) tile.anim.currentTime = startAt * duration;
    tile.anim.onfinish = () => spawn(tile);
  }

  // Fewer tiles on small screens. A window that grows gets more straight away;
  // one that shrinks loses them as they fade out.
  function fill() {
    while (tiles.length < wanted()) addTile();
  }

  function addTile() {
    const node = document.createElement('div');
    node.className = 'mote';
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    const note = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    note.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-note');
    note.append(use);
    node.append(img, note);
    box.append(node);
    const tile = { node, img, key: null, anim: null };
    tiles.push(tile);
    spawn(tile, rand(0.05, 0.9)); // start mid-flight so the page is not empty at first
  }

  let resizing;
  window.addEventListener('resize', () => {
    clearTimeout(resizing);
    resizing = setTimeout(fill, 300);
  });
  fill();

  return { remember };
})();
