// Core: config, layout, pages, touch and gesture handling.
(function () {
  let uid = 0;
  const newId = () => 'w' + Date.now().toString(36) + (uid++).toString(36);

  const key = (x, y, label, actionType, target, extra = {}) =>
    Object.assign({ id: newId(), type: 'key', x, y, w: 1, h: 1, label, actionType, actionTarget: target }, extra);

  function defaultConfig() {
    const grid = { cols: 14, rows: 4, gap: 14, padding: 18 };
    const legacy = {
      version: 1,
      grid,
      theme: { accent: '#4cc2ff', background: '#060708', tile: '#14171c', radius: 22, textScale: 100 },
      homeAssistant: { url: 'http://homeassistant.local:8123', token: '' },
      device: { flipX: false, flipY: false, swapXY: false, screenName: '', showTouches: false, fixStretch: true },
      teams: { enabled: true, autoPage: true, stayAwake: true, lightsOn: false },
      screensaver: { dimAfter: 10, dimLevel: 20, blankAfter: 30, blankClock: true, pixelShift: true, schedule: false, scheduleFrom: '23:00', scheduleTo: '07:00' },
      pages: buildTemplate('minimal', ['media']).pages,
    };
    return toProfiles(legacy);
  }

  // ---------- Starting layouts ----------
  // Widgets are packed onto pages in order (first free spot); anything that
  // doesn't fit starts a new page. `features` comes from setup's checklist:
  // meetings, lights, omnifocus, calendar, media, homeassistant, badges.
  function packPages(grid, groups) {
    const pages = [];
    for (const { name, items } of groups) {
      const group = [{ name, widgets: [] }];
      const fits = (pg, x, y, w, h) => !pg.widgets.some((o) => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y);
      const spotOn = (pg, w, h) => {
        for (let y = 0; y <= grid.rows - h; y++) for (let x = 0; x <= grid.cols - w; x++) if (fits(pg, x, y, w, h)) return { x, y };
        return null;
      };
      for (const it of items) {
        const w = Math.min(it.w, grid.cols), h = Math.min(it.h, grid.rows);
        // Fill earlier pages first; start a new page only when none has room.
        let page = group.find((pg) => spotOn(pg, w, h));
        if (!page) { page = { name: `${name} ${group.length + 1}`, widgets: [] }; group.push(page); }
        page.widgets.push(Object.assign({ id: newId() }, it.widget, spotOn(page, w, h), { w, h }));
      }
      pages.push(...group);
    }
    return pages.filter((pg) => pg.widgets.length || pages.length === 1);
  }

  const appKey = (label, id) => ({ w: 1, h: 1, widget: { type: 'key', label, actionType: 'app', actionTarget: id } });
  function buildTemplate(kind, features = []) {
    const has = (f) => features.includes(f);
    const grid = { cols: 14, rows: 4, gap: 14, padding: 18 };
    const W = (type, w, h, props = {}) => ({ w, h, widget: Object.assign({ type }, props) });
    let groups;
    if (kind === 'blank') {
      groups = [{ name: 'Main', items: [] }];
    } else if (kind === 'work') {
      const work = [];
      if (has('omnifocus')) work.push(W('omnifocus', 5, 4, { perspective: '', showProject: true, columns: 'auto' }));
      if (has('calendar')) work.push(W('calendar', 4, 4, { days: 2, limit: 6, allDay: true }));
      if (has('media')) work.push(W('media', 5, 2, { showVolume: true, blurArtwork: true }));
      work.push(W('clock', 3, 1, { format24: true, showDate: true }));
      if (has('lights')) work.push(W('elgato', 4, 2, { light: 'all' }));
      if (has('badges')) work.push(W('badges', 5, 1, { apps: [], showNames: true }));
      if (has('meetings')) work.push(W('audio', 2, 1, { mode: 'mic' }));
      work.push(W('system', 5, 1, {}));
      groups = [{ name: 'Work', items: work }];
      if (has('homeassistant')) {
        groups.push({ name: 'Home', items: [W('ha-entity', 3, 1, { entity: '', showSlider: true }), W('ha-entity', 3, 1, { entity: '', showSlider: true }), W('ha-camera', 6, 2, { entity: '', refresh: 5 })] });
      }
    } else {   // minimal
      const main = [W('clock', 3, 2, { format24: true, showDate: true })];
      main.push(has('media') ? W('media', 5, 2, { showVolume: true, blurArtwork: true }) : W('weather', 5, 2, { location: '', units: 'c', forecastDays: 3 }));
      main.push(appKey('Safari', 'com.apple.Safari'), appKey('Finder', 'com.apple.finder'), appKey('Mail', 'com.apple.mail'), appKey('Calendar', 'com.apple.iCal'));
      if (has('lights')) main.push(W('elgato', 4, 2, { light: 'all' }));
      if (has('meetings')) main.push(W('audio', 2, 1, { mode: 'mic' }));
      if (has('calendar')) main.push(W('calendar', 4, 2, { days: 1, limit: 4, allDay: false }));
      groups = [{ name: 'Main', items: main }];
    }
    const names = { work: 'Work desk', minimal: 'Minimal', blank: 'Blank' };
    return { id: newId(), name: names[kind] || 'Layout', grid, pages: packPages(grid, groups) };
  }

  // The meeting page: shared by every profile, shown during Teams/Zoom meetings.
  function defaultMeeting(grid) {
    return {
      name: 'Meeting',
      grid: Object.assign({}, grid),
      widgets: [
        { id: newId(), type: 'teams', x: 0, y: 0, w: 10, h: 3, showReactions: true, showExtras: true },
        { id: newId(), type: 'calendar', x: 10, y: 0, w: 4, h: 4, days: 1, limit: 6, allDay: false },
        { id: newId(), type: 'audio', x: 0, y: 3, w: 5, h: 1, mode: 'output' },
        { id: newId(), type: 'clock', x: 5, y: 3, w: 3, h: 1, format24: true, showDate: false },
      ],
    };
  }

  // Version 1 kept one list of pages and one grid. Version 2 has profiles (each
  // its own pages and grid) and one meeting page outside them. The old meeting
  // page (the one Teams switched to) becomes the meeting page.
  function toProfiles(cfg) {
    if (Array.isArray(cfg.profiles)) return cfg;
    const grid = Object.assign({ cols: 14, rows: 4, gap: 14, padding: 18 }, cfg.grid);
    let pages = Array.isArray(cfg.pages) ? cfg.pages : [];
    const meetingName = String((cfg.teams && cfg.teams.page) || 'Teams').toLowerCase();
    const mIdx = pages.findIndex((p) => String(p.name).toLowerCase() === meetingName && (p.widgets || []).some((w) => w.type === 'teams'));
    let meeting = null;
    if (mIdx >= 0) {
      meeting = { name: 'Meeting', grid: Object.assign({}, grid), widgets: pages[mIdx].widgets };
      pages = pages.filter((_, i) => i !== mIdx);
    }
    const profile = { id: newId(), name: 'Default', grid, pages: pages.length ? pages : [{ name: 'Main', widgets: [] }] };
    const out = Object.assign({}, cfg, { version: 2, profiles: [profile], activeProfile: profile.id, meeting: meeting || defaultMeeting(grid) });
    delete out.pages;
    delete out.grid;
    if (out.teams) delete out.teams.page;
    out._migrated = true;   // tells the dashboard to save the new shape once
    return out;
  }

  // The active profile. cfg.pages and cfg.grid are kept pointing at its pages and
  // grid (same objects), so most code can keep using them.
  function activeProfile(cfg) {
    return cfg.profiles.find((p) => p.id === cfg.activeProfile) || cfg.profiles[0];
  }
  function selectProfile(cfg, id) {
    cfg.activeProfile = id;
    const prof = activeProfile(cfg);
    cfg.activeProfile = prof.id;
    cfg.pages = prof.pages;
    cfg.grid = prof.grid;
    return prof;
  }

  // The config as it is saved: without the cfg.pages/cfg.grid shortcuts.
  function forSaving(cfg) {
    const out = Object.assign({}, cfg);
    delete out.pages;
    delete out.grid;
    delete out._migrated;
    return out;
  }

  function mergeDefaults(cfg) {
    const d = defaultConfig();
    cfg = toProfiles(cfg);
    const baseGrid = d.profiles[0].grid;
    if (!cfg.profiles.length) cfg.profiles = d.profiles;
    for (const prof of cfg.profiles) {
      if (!prof.id) prof.id = newId();
      prof.name = prof.name || 'Profile';
      prof.grid = Object.assign({}, baseGrid, prof.grid);
      if (!Array.isArray(prof.pages) || !prof.pages.length) prof.pages = [{ name: 'Main', widgets: [] }];
      for (const p of prof.pages) {
        p.widgets = p.widgets || [];
        for (const w of p.widgets) if (!w.id) w.id = newId();
      }
    }
    cfg.meeting = cfg.meeting || defaultMeeting(baseGrid);
    cfg.meeting.name = 'Meeting';
    cfg.meeting.grid = Object.assign({}, baseGrid, cfg.meeting.grid);
    cfg.meeting.widgets = cfg.meeting.widgets || [];
    for (const w of cfg.meeting.widgets) if (!w.id) w.id = newId();
    // The meeting page always has its meeting controls.
    if (!cfg.meeting.widgets.some((w) => w.type === 'teams')) {
      cfg.meeting.widgets.unshift({ id: newId(), type: 'teams', x: 0, y: 0, w: Math.min(10, cfg.meeting.grid.cols), h: Math.min(3, cfg.meeting.grid.rows) });
    }
    selectProfile(cfg, cfg.activeProfile);
    cfg.theme = Object.assign({}, d.theme, cfg.theme);
    cfg.homeAssistant = Object.assign({}, d.homeAssistant, cfg.homeAssistant);
    cfg.device = Object.assign({}, d.device, cfg.device);
    cfg.screensaver = Object.assign({}, d.screensaver, cfg.screensaver);
    cfg.teams = Object.assign({}, d.teams, cfg.teams);
    clampToGrid(cfg);
    return cfg;
  }

  // Keeps every widget inside its grid (a profile's or the meeting page's grid can shrink).
  function clampToGrid(cfg) {
    const clamp = (g, pages) => {
      g.cols = Math.max(4, Math.min(30, Math.round(g.cols || 14)));
      g.rows = Math.max(1, Math.min(10, Math.round(g.rows || 4)));
      for (const p of pages) for (const w of p.widgets) {
        w.w = Math.max(1, Math.min(w.w || 1, g.cols)); w.h = Math.max(1, Math.min(w.h || 1, g.rows));
        w.x = Math.max(0, Math.min(w.x || 0, g.cols - w.w)); w.y = Math.max(0, Math.min(w.y || 0, g.rows - w.h));
      }
    };
    for (const prof of cfg.profiles || []) clamp(prof.grid, prof.pages);
    if (cfg.meeting) clamp(cfg.meeting.grid, [cfg.meeting]);
    return cfg;
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, kind = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ''), 3000);
  }

  // ---------- Theme ----------
  function applyTheme(cfg, root = document.documentElement) {
    const t = cfg.theme;
    root.style.setProperty('--accent', t.accent);
    root.style.setProperty('--bg', t.background);
    root.style.setProperty('--tile', t.tile);
    root.style.setProperty('--radius', t.radius + 'px');
    // Every text size in style.css is multiplied by this (icons aren't).
    const scale = Math.max(70, Math.min(200, Number(t.textScale) || 100)) / 100;
    root.style.setProperty('--text-scale', String(scale));
    root.style.setProperty('--gap', cfg.grid.gap + 'px');
    root.style.setProperty('--pad', cfg.grid.padding + 'px');
  }

  const gridFor = (page, cfg) => page.grid || cfg.grid;

  // ---------- Rendering a page ----------
  // Returns a handle with destroy().
  function renderPage(container, page, cfg, ctx) {
    container.innerHTML = '';
    container.classList.add('grid');
    const grid = gridFor(page, cfg);
    container.style.gridTemplateColumns = `repeat(${grid.cols}, minmax(0, 1fr))`;
    container.style.gridTemplateRows = `repeat(${grid.rows}, minmax(0, 1fr))`;
    container.style.setProperty('--gap', grid.gap + 'px');
    container.style.setProperty('--pad', grid.padding + 'px');
    const instances = [];
    for (const w of page.widgets) {
      const def = window.Widgets[w.type];
      const el = document.createElement('div');
      el.className = 'widget w-' + w.type;
      el.dataset.id = w.id;
      el.style.gridColumn = `${w.x + 1} / span ${w.w}`;
      el.style.gridRow = `${w.y + 1} / span ${w.h}`;
      if (w.color) el.style.setProperty('--tile', w.color);
      container.appendChild(el);
      if (!def) {
        el.textContent = 'Unknown widget: ' + w.type;
        continue;
      }
      try {
        instances.push(def.create(el, w, ctx) || {});
      } catch (e) {
        el.textContent = 'Widget error: ' + e.message;
        EdgeBridge.log('Widget ' + w.type + ' failed: ' + e.stack);
      }
    }
    return {
      destroy() {
        for (const i of instances) if (i.destroy) try { i.destroy(); } catch (e) {}
        container.innerHTML = '';
      },
    };
  }

  // ---------- Gestures (shared by touch and mouse) ----------
  // Elements opt in with el._edgeTap(g), el._edgeLong(g), el._edgeDrag = {start, move, end}.
  // A scrollable container sets el._edgeScroll = true: a mostly vertical drag inside it scrolls it.
  const Gestures = {
    active: new Map(),
    enabled: true,

    down(id, x, y) {
      if (!this.enabled) return;
      if (Saver.intercept()) return;   // this press only wakes the screen; move/up ignore it too
      const target = document.elementFromPoint(x, y);
      const g = { id, x0: x, y0: y, x, y, t0: performance.now(), mode: null, drag: null, tap: null, long: null, pressed: null };
      for (let el = target; el && el !== document.body; el = el.parentElement) {
        if (el._edgeDrag && !g.drag && !g.tap) g.drag = el;
        if (el._edgeTap && !g.tap && !g.drag) g.tap = el;
        if (el._edgeLong && !g.long) g.long = el;
        if (el._edgeScroll && !g.scroll) g.scroll = el;
      }
      this.active.set(id, g);
      if (g.drag) {
        g.mode = 'drag';
        g.drag._edgeDrag.start && g.drag._edgeDrag.start(x, y, g);
        return;
      }
      const pressEl = g.tap || g.long;
      if (pressEl) {
        g.pressed = pressEl.closest('.pressable') || pressEl;
        g.pressed.classList.add('pressed');
      }
      if (g.long) {
        g.longTimer = setTimeout(() => {
          if (g.mode) return;
          g.mode = 'long';
          this.unpress(g);
          g.long._edgeLong(g);
        }, 550);
      }
    },

    move(id, x, y) {
      const g = this.active.get(id);
      if (!g) return;
      const now = performance.now();
      g.vx = (x - g.x) / Math.max(1, now - (g.tLast || g.t0));
      g.tLast = now;
      g.x = x;
      g.y = y;
      const dx = x - g.x0;
      const dy = y - g.y0;
      if (g.mode === 'drag') {
        g.drag._edgeDrag.move && g.drag._edgeDrag.move(x, y, g);
      } else if (g.mode === 'scroll') {
        g.scroll.scrollTop = g.scrollTop0 - dy / Canvas.sy;   // screen pixels -> layout pixels
      } else if (g.mode === 'swipe') {
        Pages.dragMove(dx);
      } else if (!g.mode && (Math.abs(dx) > 22 || Math.abs(dy) > 22)) {
        clearTimeout(g.longTimer);
        this.unpress(g);
        if (Math.abs(dx) > Math.abs(dy) && Pages.count > 1 && this.active.size === 1) {
          g.mode = 'swipe';
          Pages.dragStart();
          Pages.dragMove(dx);
        } else if (g.scroll && Math.abs(dy) >= Math.abs(dx)) {
          g.mode = 'scroll';
          g.scrollTop0 = g.scroll.scrollTop;
          g.scroll.scrollTop = g.scrollTop0 - dy / Canvas.sy;
        } else {
          g.mode = 'cancel';
        }
      }
    },

    up(id) {
      const g = this.active.get(id);
      if (!g) return;
      this.active.delete(id);
      clearTimeout(g.longTimer);
      this.unpress(g);
      if (g.mode === 'drag') {
        g.drag._edgeDrag.end && g.drag._edgeDrag.end(g.x, g.y, g);
      } else if (g.mode === 'swipe') {
        Pages.dragEnd(g.x - g.x0, g.vx || 0);
      } else if (!g.mode && g.tap) {
        const el = g.tap;
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 250);
        try { el._edgeTap(g); } catch (e) { EdgeBridge.log(e.stack); }
      }
    },

    unpress(g) {
      if (g.pressed) g.pressed.classList.remove('pressed');
      g.pressed = null;
    },
  };

  // Touches from the Mac app arrive as [[id, x, y], ...] normalised to 0..1.
  const EdgeTouch = {
    known: new Set(),
    dots: new Map(),
    frame(list) {
      if (Calibration.active) { Calibration.frame(list); return; }
      const W = window.innerWidth;
      const H = window.innerHeight;
      const seen = new Set();
      for (const [rawId, rx, ry] of list) {
        const id = 't' + rawId;
        const [nx, ny] = Calibration.apply(rx, ry);
        const x = nx * W;
        const y = ny * H;
        seen.add(id);
        if (!this.known.has(id)) {
          this.known.add(id);
          Gestures.down(id, x, y);
        } else {
          Gestures.move(id, x, y);
        }
        this.showDot(id, x, y);
      }
      for (const id of [...this.known]) {
        if (!seen.has(id)) {
          this.known.delete(id);
          Gestures.up(id);
          this.hideDot(id);
        }
      }
    },
    showDot(id, x, y) {
      if (!(State.config && State.config.device.showTouches)) return;
      let d = this.dots.get(id);
      if (!d) {
        d = document.createElement('div');
        d.className = 'touch-dot';
        document.body.appendChild(d);
        this.dots.set(id, d);
      }
      d.style.transform = `translate(${x / Canvas.sx}px, ${y / Canvas.sy}px)`;
    },
    hideDot(id) {
      const d = this.dots.get(id);
      if (d) d.remove();
      this.dots.delete(id);
    },
  };

  function bindMouse() {
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button !== 0) return;
      Gestures.down('p' + e.pointerId, e.clientX, e.clientY);
    });
    window.addEventListener('pointermove', (e) => Gestures.move('p' + e.pointerId, e.clientX, e.clientY));
    window.addEventListener('pointerup', (e) => Gestures.up('p' + e.pointerId));
    window.addEventListener('pointercancel', (e) => Gestures.up('p' + e.pointerId));
    // Browser preview on a real touch device
    const tl = (fn) => (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) fn('x' + t.identifier, t.clientX, t.clientY);
    };
    window.addEventListener('touchstart', tl((id, x, y) => Gestures.down(id, x, y)), { passive: false });
    window.addEventListener('touchmove', tl((id, x, y) => Gestures.move(id, x, y)), { passive: false });
    window.addEventListener('touchend', tl((id) => Gestures.up(id)), { passive: false });
    window.addEventListener('touchcancel', tl((id) => Gestures.up(id)), { passive: false });
  }

  // ---------- Touch calibration ----------
  // Five targets (four near the corners, then the centre). Each touch is
  // reduced to the median of its samples, then an affine map from raw touch
  // position to screen position is fitted by least squares:
  //   x' = a*x + b*y + c,  y' = d*x + e*y + f
  // which covers offset, scale, flips, swapped axes and slight rotation.
  // Saved as device.calibration = [a, b, c, d, e, f] (all in 0..1 units).
  const TARGETS = [[0.06, 0.12], [0.94, 0.12], [0.94, 0.88], [0.06, 0.88], [0.5, 0.5]];
  const Calibration = {
    active: false,
    phase: '',          // 'collect' | 'test'
    step: 0,
    samples: [],
    raw: [],
    fit: null,
    contact: null,      // test phase: last calibrated position of the touch
    overlay: null,
    idleTimer: null,

    apply(x, y, coeffs) {
      const c = coeffs || (State.config && State.config.device && State.config.device.calibration);
      if (!Array.isArray(c) || c.length !== 6) return [x, y];
      const clamp = (v) => Math.max(0, Math.min(1, v));
      return [clamp(c[0] * x + c[1] * y + c[2]), clamp(c[3] * x + c[4] * y + c[5])];
    },

    start() {
      this.stop();
      this.active = true;
      this.overlay = document.createElement('div');
      this.overlay.className = 'cal-overlay';
      document.body.appendChild(this.overlay);
      this.collect();
    },

    stop() {
      clearTimeout(this.idleTimer);
      if (this.overlay) this.overlay.remove();
      this.overlay = null;
      this.active = false;
    },

    // Give up quietly if nobody touches the screen for a while.
    keepAlive() {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { this.stop(); toast('Calibration cancelled'); }, 90000);
    },

    collect(message) {
      this.phase = 'collect';
      this.step = 0;
      this.raw = [];
      this.samples = [];
      this.showTarget(message);
    },

    showTarget(message) {
      const [tx, ty] = TARGETS[this.step];
      this.overlay.innerHTML = `
        <div class="cal-help">
          <div class="cal-help-title">Touch calibration</div>
          <div>${message || 'Touch the centre of the target and lift your finger.'}</div>
          <div class="cal-help-step">Target ${this.step + 1} of ${TARGETS.length}</div>
        </div>
        <div class="cal-target" style="left:${tx * 100}%;top:${ty * 100}%"><span></span></div>`;
      this.keepAlive();
    },

    frame(list) {
      this.keepAlive();
      if (this.phase === 'collect') return this.collectFrame(list);
      return this.testFrame(list);
    },

    collectFrame(list) {
      if (list.length) {
        const [, x, y] = list[0];
        this.samples.push([x, y]);
        this.overlay.querySelector('.cal-target').classList.add('hit');
        return;
      }
      if (!this.samples.length) return;   // a lift with nothing recorded
      // The first few samples can be noisy as the finger lands; skip them if we can.
      const s = this.samples.length > 6 ? this.samples.slice(3) : this.samples;
      const median = (a) => { const b = [...a].sort((p, q) => p - q); return b[Math.floor(b.length / 2)]; };
      this.raw.push([median(s.map((p) => p[0])), median(s.map((p) => p[1]))]);
      this.samples = [];
      this.step++;
      if (this.step < TARGETS.length) return this.showTarget();
      this.finish();
    },

    finish() {
      const fx = this.solve(this.raw, TARGETS.map((t) => t[0]));
      const fy = this.solve(this.raw, TARGETS.map((t) => t[1]));
      if (!fx || !fy) return this.collect('Those touches were too close together. Let’s try again.');
      const fit = [...fx, ...fy].map((v) => Math.round(v * 1e5) / 1e5);
      // How far each touch lands from its target with the new mapping, as a share of the screen.
      const worst = Math.max(...this.raw.map(([x, y], i) => {
        const [cx, cy] = this.apply(x, y, fit);
        return Math.hypot(cx - TARGETS[i][0], (cy - TARGETS[i][1]) * (720 / 2560));
      }));
      EdgeBridge.log(`Calibration: raw ${JSON.stringify(this.raw.map((p) => p.map((v) => +v.toFixed(4))))} -> ${JSON.stringify(fit)}, worst error ${(worst * 100).toFixed(2)}%`);
      if (worst > 0.03) return this.collect('One of those touches didn’t line up with the others. Let’s try again.');
      this.fit = fit;
      this.test();
    },

    // Least squares for v = a*x + b*y + c over the collected points.
    solve(points, values) {
      let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = 0, sxv = 0, syv = 0, sv = 0;
      points.forEach(([x, y], i) => {
        const v = values[i];
        sxx += x * x; sxy += x * y; sx += x; syy += y * y; sy += y; n += 1;
        sxv += x * v; syv += y * v; sv += v;
      });
      const m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
      const det = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
      const d = det(m);
      if (Math.abs(d) < 1e-9) return null;
      const r = [sxv, syv, sv];
      return [0, 1, 2].map((col) => det(m.map((row, i) => row.map((v, j) => (j === col ? r[i] : v)))) / d);
    },

    test() {
      this.phase = 'test';
      this.contact = null;
      this.overlay.innerHTML = `
        <div class="cal-help">
          <div class="cal-help-title">Check it</div>
          <div>Touch anywhere. The dot should sit right under your finger.</div>
        </div>
        <div class="cal-dot"></div>
        <div class="cal-actions">
          <button class="cal-btn" data-cal="cancel">Cancel</button>
          <button class="cal-btn" data-cal="redo">Redo</button>
          <button class="cal-btn primary" data-cal="save">Save</button>
        </div>`;
      this.keepAlive();
    },

    testFrame(list) {
      const dot = this.overlay.querySelector('.cal-dot');
      if (list.length) {
        const [, rx, ry] = list[0];
        const [x, y] = this.apply(rx, ry, this.fit);
        this.contact = [x, y];
        dot.style.display = 'block';
        dot.style.left = x * 100 + '%';
        dot.style.top = y * 100 + '%';
        return;
      }
      dot.style.display = 'none';
      if (!this.contact) return;
      const [x, y] = this.contact;
      this.contact = null;
      const el = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight);
      const action = el && el.closest('[data-cal]') && el.closest('[data-cal]').dataset.cal;
      if (action === 'cancel') { this.stop(); toast('Calibration cancelled'); }
      else if (action === 'redo') this.collect();
      else if (action === 'save') this.save(this.fit);
    },

    async save(fit) {
      this.stop();
      State.config.device.calibration = fit;
      try {
        await EdgeBridge.call('config.update', { section: 'device', json: JSON.stringify(State.config.device) });
        toast(fit ? 'Touch calibration saved' : 'Touch calibration reset');
      } catch (e) {
        toast('Couldn’t save calibration: ' + e.message, 'error');
      }
    },
  };

  // ---------- Screen saver ----------
  // The Edge is an LCD, so the risk is image retention rather than OLED-style
  // burn-in, but a fixed layout shown all day is the worst case. After a while
  // without a touch the dashboard dims, then blanks (with an optional drifting
  // clock); the first touch afterwards only wakes it. The whole layout also
  // shifts by a few pixels every few minutes, and it can blank on a schedule.
  const SHIFT_POINTS = [[0, 0], [2, 1], [3, -1], [1, -3], [-2, -2], [-3, 1], [-1, 3], [2, 3]];
  const Saver = {
    state: 'awake',        // 'awake' | 'dim' | 'blank'
    lastActivity: Date.now(),
    forced: false,         // "Blank Edge Now" from the menu bar
    running: false,
    el: null,
    clockEl: null,
    clockTimer: null,
    shiftIndex: 0,

    settings() { return (State.config && State.config.screensaver) || {}; },

    start() {
      if (this.running) return;
      this.running = true;
      this.el = document.createElement('div');
      this.el.className = 'saver';
      this.el.innerHTML = '<div class="saver-clock"></div>';
      document.body.appendChild(this.el);
      this.clockEl = this.el.querySelector('.saver-clock');
      setInterval(() => this.tick(), 5000);
      setInterval(() => this.shift(), 3 * 60000);
      this.tick();
    },

    // Called when a touch or click starts. Returns true if the screen was
    // dimmed or blank, in which case the press should do nothing else.
    intercept() {
      if (!this.running) return false;
      const sleeping = this.state !== 'awake';
      this.lastActivity = Date.now();
      this.forced = false;
      if (sleeping) this.set('awake');
      return sleeping;
    },

    minutes(hhmm) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
      return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null;
    },

    inSchedule() {
      const s = this.settings();
      if (!s.schedule) return false;
      const from = this.minutes(s.scheduleFrom), to = this.minutes(s.scheduleTo);
      if (from == null || to == null || from === to) return false;
      const now = new Date();
      const t = now.getHours() * 60 + now.getMinutes();
      return from < to ? t >= from && t < to : t >= from || t < to;   // the window may run past midnight
    },

    tick() {
      if (Calibration.active) { this.lastActivity = Date.now(); return; }
      // Stay awake for the length of a Teams meeting (unless turned off).
      if (window.EdgeTeams && EdgeTeams.inMeeting && State.config.teams.stayAwake !== false && !this.forced) {
        this.lastActivity = Date.now();
      }
      const s = this.settings();
      const idle = (Date.now() - this.lastActivity) / 60000;
      // Inside the schedule the screen blanks a minute after the last touch.
      const blankAfter = this.inSchedule() ? 1 : Number(s.blankAfter ?? 30);
      const dimAfter = Number(s.dimAfter ?? 10);
      let want = 'awake';
      if (this.forced || (blankAfter > 0 && idle >= blankAfter)) want = 'blank';
      else if (dimAfter > 0 && idle >= dimAfter) want = 'dim';
      if (want !== this.state) this.set(want);
    },

    set(state) {
      this.state = state;
      const s = this.settings();
      const level = Math.max(0, Math.min(100, Number(s.dimLevel ?? 20))) / 100;
      this.el.style.opacity = state === 'awake' ? '0' : state === 'dim' ? String(1 - level) : '1';
      const clock = state === 'blank' && s.blankClock !== false;
      this.el.classList.toggle('show-clock', clock);
      clearInterval(this.clockTimer);
      if (clock) {
        this.moveClock();
        this.clockTimer = setInterval(() => this.moveClock(), 60000);
      }
      EdgeBridge.log('Screen saver: ' + state);
    },

    // A small clock that jumps somewhere new each minute, so it never sits on the same pixels.
    moveClock() {
      this.clockEl.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      this.clockEl.style.left = 4 + Math.random() * 84 + '%';
      this.clockEl.style.top = 8 + Math.random() * 72 + '%';
    },

    // Wake the screen without a touch (e.g. a meeting starting).
    wake() {
      if (!this.running) return;
      this.lastActivity = Date.now();
      this.forced = false;
      if (this.state !== 'awake') this.set('awake');
    },

    blankNow() {
      if (!this.running) return;
      this.forced = true;
      this.set('blank');
    },

    // Nudges the whole layout around a small loop of offsets (at most 3 px),
    // so tile edges don't sit on exactly the same pixels all day.
    shift() {
      const app = document.getElementById('app');
      if (!app) return;
      if (this.settings().pixelShift === false) { app.style.transform = ''; return; }
      this.shiftIndex = (this.shiftIndex + 1) % SHIFT_POINTS.length;
      const [x, y] = SHIFT_POINTS[this.shiftIndex];
      app.style.transform = `translate(${x}px, ${y}px)`;
    },
  };

  // ---------- Canvas ----------
  // If macOS sends the Edge a 16:9 signal, the panel stretches it across its
  // 32:9 glass. The Mac app then asks us to lay out at the panel's real size
  // (2560x720) and squash the page to fit the window, so the panel's stretch
  // cancels out. Touch input still works because elementFromPoint and
  // getBoundingClientRect both use on-screen (transformed) coordinates.
  const Canvas = {
    w: 0, h: 0,        // 0 = use the window as it is
    sx: 1, sy: 1,
    width() { return this.w || window.innerWidth; },
    set(w, h) {
      this.w = w > 0 ? w : 0;
      this.h = h > 0 ? h : 0;
      this.apply();
    },
    apply() {
      const b = document.body;
      if (this.w && this.h) {
        this.sx = window.innerWidth / this.w;
        this.sy = window.innerHeight / this.h;
        Object.assign(b.style, { width: this.w + 'px', height: this.h + 'px', transformOrigin: '0 0', transform: `scale(${this.sx}, ${this.sy})` });
      } else {
        this.sx = this.sy = 1;
        Object.assign(b.style, { width: '', height: '', transformOrigin: '', transform: '' });
      }
      document.documentElement.style.setProperty('--page-w', this.width() + 'px');
      if (Pages.track) {
        Pages.track.style.width = Pages.count * this.width() + 'px';
        Pages.go(Pages.index, false);
      }
    },
  };

  // ---------- Pages ----------
  const Pages = {
    index: 0,
    count: 0,
    track: null,
    dotsEl: null,
    width() { return Canvas.width(); },
    dragStart() { this.track.style.transition = 'none'; },
    dragMove(dx) {
      dx /= Canvas.sx;   // finger distance on screen -> layout pixels
      const atEdge = (this.index === 0 && dx > 0) || (this.index === this.count - 1 && dx < 0);
      const d = atEdge ? dx * 0.3 : dx;
      this.track.style.transform = `translateX(${-this.index * this.width() + d}px)`;
    },
    dragEnd(dx, vx) {
      dx /= Canvas.sx;
      vx /= Canvas.sx;
      const W = this.width();
      if ((dx < -W * 0.12 || vx < -0.6) && this.index < this.count - 1) this.index++;
      else if ((dx > W * 0.12 || vx > 0.6) && this.index > 0) this.index--;
      this.go(this.index);
    },
    go(i, animate = true) {
      this.index = Math.max(0, Math.min(this.count - 1, i));
      this.track.style.transition = animate ? 'transform .38s cubic-bezier(.2,.8,.2,1)' : 'none';
      this.track.style.transform = `translateX(${-this.index * this.width()}px)`;
      try { sessionStorage.setItem('edgedeck.page', String(this.index)); } catch (e) {}
      if (this.dotsEl) {
        [...this.dotsEl.children].forEach((d, n) => d.classList.toggle('on', n === this.index));
      }
    },
    indexOf(name) {
      const pages = State.config.pages;
      return /^\d+$/.test(String(name)) ? Number(name) - 1 : pages.findIndex((p) => p.name.toLowerCase() === String(name).toLowerCase());
    },
    goByName(name) {
      const n = this.indexOf(name);
      if (n >= 0 && n < State.config.pages.length) this.go(n);
    },
  };

  // ---------- App state ----------
  const State = { config: null, rendered: [] };

  async function loadConfig() {
    let cfg = null;
    try {
      const res = await EdgeBridge.call('config.get');
      if (res && res.config) cfg = JSON.parse(res.config);
    } catch (e) {
      toast('Could not read config: ' + e.message, 'error');
    }
    return mergeDefaults(cfg || defaultConfig());
  }

  function context() {
    return {
      config: State.config,
      ha: window.HA,
      bridge: window.EdgeBridge,
      toast,
      pages: Pages,
      edit: false,
    };
  }

  function renderDashboard() {
    const cfg = State.config;
    applyTheme(cfg);
    HA.configure(cfg.homeAssistant.url, cfg.homeAssistant.token);
    for (const r of State.rendered) r.destroy();
    State.rendered = [];

    const app = document.getElementById('app');
    app.className = 'dashboard';
    app.innerHTML = '<div class="track"></div><div class="page-dots"></div>';
    const track = app.querySelector('.track');
    const dots = app.querySelector('.page-dots');
    const shown = State.showMeeting ? [...cfg.pages, cfg.meeting] : cfg.pages;
    Pages.track = track;
    Pages.dotsEl = dots;
    Pages.count = shown.length;
    track.style.width = shown.length * Canvas.width() + 'px';

    shown.forEach((page) => {
      const el = document.createElement('div');
      el.className = 'page' + (page === cfg.meeting ? ' meeting-page' : '');
      track.appendChild(el);
      State.rendered.push(renderPage(el, page, cfg, context()));
      const dot = document.createElement('span');
      if (page === cfg.meeting) dot.className = 'meeting';
      dots.appendChild(dot);
    });
    dots.style.display = shown.length > 1 ? '' : 'none';
    let saved = 0;
    try { saved = Number(sessionStorage.getItem('edgedeck.page') || 0); } catch (e) {}
    Pages.go(Math.min(saved, shown.length - 1), false);
  }

  const EdgeDeck = {
    defaultConfig,
    mergeDefaults,
    clampToGrid,
    selectProfile,
    activeProfile,
    forSaving,
    gridFor,
    buildTemplate,
    newId,
    renderPage,
    applyTheme,
    toast,
    Gestures,
    Pages,
    State,
    context,
    mode: window.EDGE_MODE || new URLSearchParams(location.search).get('mode') || 'dashboard',

    async start() {
      bindMouse();
      State.config = await loadConfig();
      if (State.config._migrated && this.mode === 'dashboard') {
        // First run after profiles were added: store the new shape and drop the old one.
        delete State.config._migrated;
        await EdgeBridge.call('config.save', { config: JSON.stringify(forSaving(State.config), null, 2) }).catch(() => {});
      }
      if (this.mode === 'edit') {
        Gestures.enabled = false;
        window.Editor.start(State.config);
      } else if (this.mode === 'settings') {
        Gestures.enabled = false;
        window.Settings.start(State.config);
      } else if (this.mode === 'setup') {
        Gestures.enabled = false;
        window.Setup.start(State.config);
      } else {
        try {
          const c = await EdgeBridge.call('display.canvas');
          if (c) Canvas.set(c.width, c.height);
        } catch (e) { /* older app or browser preview */ }
        renderDashboard();
        Saver.start();
        if (window.EdgeTeams) {
          // If a meeting ended while EdgeDeck wasn't running, put the meeting lights back.
          EdgeTeams.refresh().then(() => {
            let pending = null;
            try { pending = JSON.parse(localStorage.getItem('edgedeck.meetingLights') || 'null'); } catch (e) {}
            if (pending && !EdgeTeams.inMeeting) this.meetingLights(false);
          });
        }
        window.addEventListener('resize', () => Canvas.apply());
        EdgeBridge.call('app.front').then((id) => id && this.frontAppChanged(id)).catch(() => {});
      }
    },

    // ---------- Pages that follow the front app ----------
    // A page can list apps ("showWhenApps"); while one of them is in front, the
    // dashboard shows that page, and goes back to where it was afterwards
    // (unless you've moved off it yourself). Never during a meeting.
    appPage: null,
    appReturnTo: null,
    frontAppChanged(bundleID) {
      if (this.mode !== 'dashboard' || !State.config) return;
      const pages = State.config.pages;
      const idx = pages.findIndex((p) => Array.isArray(p.showWhenApps) && p.showWhenApps.includes(bundleID));
      if (this.appPage != null && Pages.index !== this.appPage) { this.appPage = null; this.appReturnTo = null; }   // you moved
      if (State.showMeeting) return;
      if (idx >= 0) {
        if (Pages.index !== idx) {
          if (this.appPage == null) this.appReturnTo = Pages.index;
          Pages.go(idx);
        }
        this.appPage = idx;
      } else if (this.appPage != null) {
        if (Pages.index === this.appPage && this.appReturnTo != null) Pages.go(Math.min(this.appReturnTo, pages.length - 1));
        this.appPage = null;
        this.appReturnTo = null;
      }
    },

    // ---------- Profiles ----------
    async switchProfile(nameOrId) {
      const prof = State.config.profiles.find((p) => p.id === nameOrId || p.name.toLowerCase() === String(nameOrId).toLowerCase());
      if (!prof) throw new Error('No profile called ' + nameOrId);
      await EdgeBridge.call('config.update', { section: 'activeProfile', json: JSON.stringify(prof.id) });
      try { sessionStorage.setItem('edgedeck.page', '0'); } catch (e) {}
    },

    // While setup runs on the main screen, the Edge says so (null clears it).
    setupProgress(p) {
      if (this.mode !== 'dashboard') return;
      let el = document.querySelector('.setup-overlay');
      if (!p) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement('div');
        el.className = 'setup-overlay';
        document.body.appendChild(el);
      }
      const dots = Array.from({ length: p.total || 0 }, (_, i) => `<span class="${i < p.step ? 'done' : i === p.step ? 'now' : ''}"></span>`).join('');
      el.innerHTML = `<div class="setup-card"><div class="setup-kicker">Setting up EdgeDeck</div><div class="setup-title">${String(p.title || '').replace(/[<>&]/g, '')}</div>
        <div class="setup-sub">Carry on in the window on your Mac’s main screen.</div><div class="setup-dots">${dots}</div></div>`;
      Saver.wake();
    },

    // Called by the Mac app when the Edge's display mode changes.
    setCanvas(w, h) { Canvas.set(w, h); },

    // Called by the Mac app (menu bar or editor) to calibrate or reset touch.
    calibrate() { if (this.mode !== 'edit') Calibration.start(); },
    resetCalibration() { if (this.mode !== 'edit') Calibration.save(null); },
    blankNow() { Saver.blankNow(); },

    // Called by EdgeTeams when a meeting starts or ends. On start: wake the
    // screen and show the Teams page. On end: go back to the page that was
    // showing, unless you've already moved off the Teams page yourself.
    meetingChanged(inMeeting) {
      if (this.mode === 'edit' || !State.config) return;
      const t = State.config.teams || {};
      if (inMeeting) Saver.wake();
      if (t.lightsOn) this.meetingLights(inMeeting);
      if (t.autoPage === false) return;
      const meetingIndex = State.config.pages.length;   // the meeting page goes after the profile's pages
      if (inMeeting) {
        if (State.showMeeting) return;
        this.returnToPage = Pages.index;
        State.showMeeting = true;
        renderDashboard();
        Pages.go(meetingIndex);
      } else if (State.showMeeting) {
        const wasOnMeeting = Pages.index === meetingIndex;
        const back = this.returnToPage;
        this.returnToPage = null;
        State.showMeeting = false;
        renderDashboard();
        const last = State.config.pages.length - 1;
        Pages.go(Math.min(wasOnMeeting && back != null ? back : Pages.index, last), false);
      }
    },
    returnToPage: null,

    // Turns the Key Lights on when a meeting starts and switches back off,
    // afterwards, only the ones that were off before.
    // The list is kept in local storage so a restart mid-meeting doesn't forget it.
    async meetingLights(inMeeting) {
      const KEY = 'edgedeck.meetingLights';
      const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
      const store = (v) => { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) {} };
      try {
        if (inMeeting) {
          if (load()) return;   // already switched on for this meeting (e.g. EdgeDeck restarted)
          // The lights may still be being found on the network: wait up to ~5 s.
          let lights = [];
          for (let i = 0; i < 6 && !lights.length; i++) {
            lights = await EdgeBridge.call('elgato.list');
            if (!lights.length) await new Promise((r) => setTimeout(r, 1000));
          }
          if (!lights.length) { EdgeBridge.log('Meeting lights: no lights found'); return; }
          const off = lights.filter((l) => l.reachable && !l.on).map((l) => l.id);
          store(off);
          if (off.length) await EdgeBridge.call('elgato.set', { ids: off, on: true });
          EdgeBridge.log(`Meeting lights: turned on ${off.length} (${lights.length - off.length} already on)`);
        } else {
          const off = load();
          store(null);
          if (off && off.length) {
            await EdgeBridge.call('elgato.set', { ids: off, on: false });
            EdgeBridge.log(`Meeting lights: turned ${off.length} back off`);
          }
        }
      } catch (e) { EdgeBridge.log('Meeting lights: ' + e.message); }
    },
    Saver,
    Calibration,

    async reloadConfig() {
      if (this.mode === 'edit') {
        // The editor owns the pages; everything else comes from Settings (or the
        // dashboard, for calibration), so take those parts from the saved config.
        const fresh = await loadConfig();
        if (window.Editor && Editor.syncSettings) Editor.syncSettings(fresh);
        return;
      }
      if (this.mode === 'settings') {
        const fresh = await loadConfig();
        if (window.Settings && Settings.sync) Settings.sync(fresh);
        return;
      }
      if (this.mode === 'setup') return;   // setup keeps its own state; it isn't a dashboard
      State.config = await loadConfig();
      renderDashboard();
    },
  };

  window.EdgeDeck = EdgeDeck;
  window.EdgeTouch = EdgeTouch;
})();
