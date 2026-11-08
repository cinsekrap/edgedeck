// Layout editor, shown in a normal window on the main screen.
(function () {
  const SCREEN_W = 2560;
  const SCREEN_H = 720;

  const E = {
    cfg: null,
    page: 0,
    selected: null,
    view: 'widget', // 'widget' | 'settings'
    dirty: false,
    rendered: null,
    apps: null,
    shortcuts: null,
    scale: 0.5,
  };

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  };

  const onMeeting = () => E.page === 'meeting';
  const curPage = () => (onMeeting() ? E.cfg.meeting : E.cfg.pages[E.page]);
  const curGrid = () => EdgeDeck.gridFor(curPage(), E.cfg);
  const profile = () => EdgeDeck.activeProfile(E.cfg);
  const selectedWidget = () => curPage().widgets.find((w) => w.id === E.selected) || null;

  function metrics() {
    const g = curGrid();
    const cw = (SCREEN_W - 2 * g.padding - (g.cols - 1) * g.gap) / g.cols;
    const ch = (SCREEN_H - 2 * g.padding - (g.rows - 1) * g.gap) / g.rows;
    return {
      cw, ch, g,
      left: (x) => g.padding + x * (cw + g.gap),
      top: (y) => g.padding + y * (ch + g.gap),
      width: (w) => w * cw + (w - 1) * g.gap,
      height: (hh) => hh * ch + (hh - 1) * g.gap,
    };
  }

  function overlaps(page, w, x, y, ww, hh) {
    return page.widgets.some((o) => o.id !== w.id && x < o.x + o.w && x + ww > o.x && y < o.y + o.h && y + hh > o.y);
  }

  function markDirty(on = true) {
    E.dirty = on;
    const d = document.querySelector('.ed-dirty');
    if (d) d.textContent = on ? 'Unsaved changes' : 'Saved';
    document.querySelector('.ed-save')?.classList.toggle('attention', on);
  }

  // ---------- Layout ----------
  function build() {
    const app = document.getElementById('app');
    app.className = 'editor';
    app.innerHTML = '';
    document.body.classList.add('editing');
    app.append(
      h('header', { class: 'ed-bar' },
        h('div', { class: 'ed-brand' }, 'EdgeDeck'),
        h('div', { class: 'ed-profile' }),
        h('div', { class: 'ed-tabs' }),
        h('div', { class: 'ed-spacer' }),
        h('div', { class: 'ed-add' },
          h('button', { class: 'ed-btn', onclick: (e) => { e.stopPropagation(); document.querySelector('.ed-add').classList.toggle('open'); } }, '+ Add widget'),
          h('div', { class: 'ed-menu' },
            Object.entries(window.Widgets).map(([type, def]) =>
              h('button', { onclick: () => { document.querySelector('.ed-add').classList.remove('open'); addWidget(type); } }, def.name)))),
        h('button', { class: 'ed-btn ed-settings-btn', onclick: () => EdgeBridge.call('settings.open') }, 'Settings…'),
        h('span', { class: 'ed-dirty' }),
        h('button', { class: 'ed-btn primary ed-save', onclick: save }, 'Save to Edge')),
      h('section', { class: 'ed-stage' },
        h('div', { class: 'ed-canvas-wrap' },
          h('div', { class: 'ed-canvas' },
            h('div', { class: 'ed-cells' }),
            h('div', { class: 'ed-page page' }),
            h('div', { class: 'ed-overlay' })))),
      h('section', { class: 'ed-inspector' }));
    document.addEventListener('click', () => document.querySelector('.ed-add')?.classList.remove('open'));
    document.querySelector('.ed-overlay').addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('ed-overlay')) select(null);
    });
    window.addEventListener('resize', fit);
    window.addEventListener('keydown', onKey);
    markDirty(false);
  }

  function fit() {
    const stage = document.querySelector('.ed-stage');
    const wrap = document.querySelector('.ed-canvas-wrap');
    const canvas = document.querySelector('.ed-canvas');
    const avail = stage.clientWidth - 40;
    E.scale = Math.min(avail / SCREEN_W, 0.75);
    canvas.style.transform = `scale(${E.scale})`;
    wrap.style.width = SCREEN_W * E.scale + 'px';
    wrap.style.height = SCREEN_H * E.scale + 'px';
  }

  function renderTabs() {
    renderProfileBar();
    const tabs = document.querySelector('.ed-tabs');
    tabs.innerHTML = '';
    E.cfg.pages.forEach((p, i) => {
      tabs.append(h('button', {
        class: 'ed-tab' + (i === E.page ? ' active' : '') + (Array.isArray(p.showWhenApps) && p.showWhenApps.length ? ' follows-app' : ''),
        onclick: () => { E.page = i; E.selected = null; E.view = 'widget'; renderAll(); },
      }, p.name || `Page ${i + 1}`));
    });
    tabs.append(h('button', { class: 'ed-tab add', title: 'Add page', onclick: addPage }, '+'));
    tabs.append(h('span', { class: 'ed-tab-sep' }));
    tabs.append(h('button', {
      class: 'ed-tab meeting' + (onMeeting() ? ' active' : ''),
      title: 'Shown during Teams and Zoom meetings, whatever profile is in use',
      onclick: () => { E.page = 'meeting'; E.selected = null; renderAll(); },
    }, '👥 Meeting'));
  }

  // ---------- Profiles ----------
  function renderProfileBar() {
    const bar = document.querySelector('.ed-profile');
    bar.innerHTML = '';
    const pick = h('select', { title: 'Profile' }, E.cfg.profiles.map((p) => h('option', { value: p.id }, p.name)));
    pick.value = E.cfg.activeProfile;
    pick.addEventListener('change', () => switchTo(pick.value));
    const actions = h('select', { class: 'ed-profile-menu', title: 'Profile actions' },
      h('option', { value: '' }, '⋯'),
      h('option', { value: 'new' }, 'New profile…'),
      h('option', { value: 'duplicate' }, 'Duplicate profile…'),
      h('option', { value: 'rename' }, 'Rename profile…'),
      E.cfg.profiles.length > 1 ? h('option', { value: 'delete' }, 'Delete profile…') : null,
      h('option', { disabled: true }, '──────────'),
      h('option', { value: 'export' }, 'Export profile…'),
      h('option', { value: 'import' }, 'Import profile…'),
      h('option', { disabled: true }, '──────────'),
      h('option', { value: 'backup' }, 'Export full backup…'),
      h('option', { value: 'restore' }, 'Restore from backup…'));
    actions.addEventListener('change', () => { const a = actions.value; actions.value = ''; profileAction(a); });
    bar.append(pick, actions);
  }

  // Switching profile saves the editor's changes and makes that profile active on the Edge.
  async function switchTo(id) {
    EdgeDeck.selectProfile(E.cfg, id);
    E.page = 0;
    E.selected = null;
    renderAll();
    await save();
  }

  const freshIds = (pages) => pages.map((pg) => Object.assign({}, pg, { widgets: pg.widgets.map((w) => Object.assign({}, w, { id: EdgeDeck.newId() })) }));
  const uniqueName = (name) => {
    let n = name, i = 2;
    while (E.cfg.profiles.some((p) => p.name.toLowerCase() === n.toLowerCase())) n = `${name} ${i++}`;
    return n;
  };

  async function profileAction(action) {
    const prof = profile();
    if (action === 'new') {
      const name = await askText('New profile', 'Name', uniqueName('New profile'));
      if (!name) return;
      const p = { id: EdgeDeck.newId(), name: uniqueName(name), grid: Object.assign({}, prof.grid), pages: [{ name: 'Main', widgets: [] }] };
      E.cfg.profiles.push(p);
      return switchTo(p.id);
    }
    if (action === 'duplicate') {
      const name = await askText('Duplicate profile', 'Name of the copy', uniqueName(prof.name + ' copy'));
      if (!name) return;
      const copy = JSON.parse(JSON.stringify(prof));
      const p = { id: EdgeDeck.newId(), name: uniqueName(name), grid: copy.grid, pages: freshIds(copy.pages) };
      E.cfg.profiles.push(p);
      return switchTo(p.id);
    }
    if (action === 'rename') {
      const name = await askText('Rename profile', 'Name', prof.name);
      if (!name || name === prof.name) return;
      prof.name = uniqueName(name);
      renderTabs();
      return save();
    }
    if (action === 'delete') {
      const ok = await confirmDialog(`Delete “${prof.name}”?`, `Its ${prof.pages.length} page(s) will be removed. This can’t be undone, unless you’ve exported it.`, 'Delete profile');
      if (!ok) return;
      E.cfg.profiles = E.cfg.profiles.filter((p) => p !== prof);
      return switchTo(E.cfg.profiles[0].id);
    }
    if (action === 'export') {
      const file = { format: 'edgedeck-profile', version: 1, exported: new Date().toISOString(), profile: { name: prof.name, grid: prof.grid, pages: prof.pages } };
      return exportFile(prof.name + '.edgedeck-profile', file);
    }
    if (action === 'backup') {
      const withToken = await confirmDialog('Export full backup', 'Saves every profile, the meeting page and all settings. Include your Home Assistant access token? Leave it out if you’ll share the file.', 'Include token', 'Leave it out');
      if (withToken === null) return;
      const config = JSON.parse(JSON.stringify(EdgeDeck.forSaving(E.cfg)));
      if (!withToken && config.homeAssistant) config.homeAssistant.token = '';
      const date = new Date().toISOString().slice(0, 10);
      return exportFile(`EdgeDeck backup ${date}.edgedeck-backup`, { format: 'edgedeck-backup', version: 1, exported: new Date().toISOString(), config });
    }
    if (action === 'import' || action === 'restore') return importFile(action);
  }

  async function exportFile(name, data) {
    try {
      const path = await EdgeBridge.call('file.save', { name, json: JSON.stringify(data, null, 2) });
      if (path) EdgeDeck.toast('Exported ' + name);
    } catch (e) { EdgeDeck.toast('Export failed: ' + e.message, 'error'); }
  }

  // Lists what's in some pages, flagging anything that runs code on this Mac.
  function describePages(pages) {
    const types = new Map();
    const risky = [];
    for (const pg of pages) for (const w of pg.widgets || []) {
      const name = (window.Widgets[w.type] && window.Widgets[w.type].name) || w.type;
      types.set(name, (types.get(name) || 0) + 1);
      if (w.type === 'script' && (w.source || w.tapSource)) risky.push(`Script widget on “${pg.name}”`);
      if (w.type === 'key' && ['shell', 'applescript', 'jxa'].includes(w.actionType)) {
        risky.push(`${w.actionType === 'shell' ? 'Shell command' : w.actionType === 'jxa' ? 'JavaScript' : 'AppleScript'} key “${w.label || ''}” on “${pg.name}”: ${String(w.actionTarget || '').slice(0, 80)}`);
      }
      // Opening a file or another app's URL scheme can run things too; plain web links are fine.
      if (w.type === 'key' && w.actionType === 'url' && !/^https?:\/\//i.test(String(w.actionTarget || '').trim())) {
        risky.push(`Key “${w.label || ''}” on “${pg.name}” opens ${String(w.actionTarget || '').slice(0, 80)}`);
      }
    }
    return { types: [...types].map(([n, c]) => `${n} × ${c}`), risky };
  }

  async function importFile(kind) {
    let text;
    try { text = await EdgeBridge.call('file.open', { kind }); } catch (e) { return EdgeDeck.toast(e.message, 'error'); }
    if (!text) return;
    let data;
    try { data = JSON.parse(text); } catch (e) { return EdgeDeck.toast('That file isn’t an EdgeDeck profile or backup', 'error'); }

    if (data.format === 'edgedeck-profile' && data.profile && Array.isArray(data.profile.pages)) {
      const p = data.profile;
      const info = describePages(p.pages);
      const ok = await reviewDialog(`Import “${p.name || 'Profile'}”`, [
        `${p.pages.length} page(s): ${p.pages.map((pg) => pg.name).join(', ')}`,
        `Widgets: ${info.types.join(', ') || 'none'}`,
      ], info.risky, 'Import as a new profile');
      if (!ok) return;
      const prof = { id: EdgeDeck.newId(), name: uniqueName(p.name || 'Imported'), grid: Object.assign({}, profile().grid, p.grid), pages: freshIds(p.pages) };
      E.cfg.profiles.push(prof);
      EdgeDeck.clampToGrid(E.cfg);
      EdgeDeck.toast('Imported “' + prof.name + '”');
      return switchTo(prof.id);
    }

    if (data.format === 'edgedeck-backup' && data.config && Array.isArray(data.config.profiles)) {
      const c = data.config;
      const allPages = [...c.profiles.flatMap((pr) => pr.pages || []), ...(c.meeting ? [c.meeting] : [])];
      const info = describePages(allPages);
      const ok = await reviewDialog('Restore from backup', [
        `Made ${data.exported ? new Date(data.exported).toLocaleString('en-GB') : 'at an unknown time'}`,
        `${c.profiles.length} profile(s): ${c.profiles.map((pr) => pr.name).join(', ')}`,
        'This replaces all your profiles, the meeting page and every setting.',
      ], info.risky, 'Replace everything');
      if (!ok) return;
      // Keep the current Home Assistant token if the backup left it out, but only for the
      // same server: a file must never be able to send your token somewhere else.
      const cur = E.cfg.homeAssistant || {};
      if (c.homeAssistant && !c.homeAssistant.token && cur.token &&
          String(c.homeAssistant.url || '').trim().replace(/\/+$/, '') === String(cur.url || '').trim().replace(/\/+$/, '')) {
        c.homeAssistant.token = cur.token;
      }
      try {
        await EdgeBridge.call('config.save', { config: JSON.stringify(c, null, 2) });
        location.reload();
      } catch (e) { EdgeDeck.toast('Restore failed: ' + e.message, 'error'); }
      return;
    }
    EdgeDeck.toast('That file isn’t an EdgeDeck profile or backup', 'error');
  }

  // ---------- Small dialogs (web views can't show prompt/confirm) ----------
  function dialog(title, body, buttons) {
    return new Promise((resolve) => {
      const close = (v) => { overlay.remove(); resolve(v); };
      const overlay = h('div', { class: 'ed-dialog-backdrop' },
        h('div', { class: 'ed-dialog' },
          h('h3', {}, title),
          h('div', { class: 'ed-dialog-body' }, body),
          h('div', { class: 'ed-dialog-buttons' }, buttons.map(([label, value, cls]) =>
            h('button', { class: 'ed-btn ' + (cls || ''), onclick: () => close(typeof value === 'function' ? value() : value) }, label)))));
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
      document.body.append(overlay);
      (overlay.querySelector('input') || overlay.querySelector('.primary'))?.focus();
    });
  }
  function askText(title, label, value) {
    const input = h('input', { type: 'text' });
    input.value = value || '';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.closest('.ed-dialog').querySelector('.primary').click(); });
    return dialog(title, [field(label, input)], [['Cancel', null], ['OK', () => input.value.trim() || null, 'primary']]);
  }
  function confirmDialog(title, text, yes, no = 'Cancel') {
    return dialog(title, [h('p', {}, text)], no === 'Cancel'
      ? [['Cancel', null], [yes, true, 'primary']]
      : [['Cancel', null], [no, false], [yes, true, 'primary']]);
  }
  function reviewDialog(title, lines, risky, yes) {
    const body = [h('ul', { class: 'ed-review' }, lines.map((l) => h('li', {}, l)))];
    if (risky.length) {
      body.push(h('div', { class: 'ed-warning' },
        h('strong', {}, '⚠︎ This runs code on your Mac:'),
        h('ul', {}, risky.map((r) => h('li', {}, r))),
        h('p', {}, 'Only import it if you trust where it came from.')));
    }
    return dialog(title, body, [['Cancel', null], [yes, true, risky.length ? 'danger' : 'primary']]);
  }

  function renderCanvas() {
    const cfg = E.cfg;
    EdgeDeck.applyTheme(cfg);
    const pageEl = document.querySelector('.ed-page');
    if (E.rendered) E.rendered.destroy();
    const ctx = Object.assign(EdgeDeck.context(), { config: cfg, edit: true });
    E.rendered = EdgeDeck.renderPage(pageEl, curPage(), cfg, ctx);

    // Grid cells
    const m = metrics();
    const cells = document.querySelector('.ed-cells');
    cells.innerHTML = '';
    for (let y = 0; y < m.g.rows; y++) {
      for (let x = 0; x < m.g.cols; x++) {
        cells.append(h('div', { class: 'ed-cell', style: `left:${m.left(x)}px;top:${m.top(y)}px;width:${m.cw}px;height:${m.ch}px` }));
      }
    }
    renderOverlay();
  }

  function renderOverlay() {
    const m = metrics();
    const overlay = document.querySelector('.ed-overlay');
    overlay.innerHTML = '';
    for (const w of curPage().widgets) {
      const box = h('div', { class: 'ed-box' + (w.id === E.selected ? ' selected' : ''), 'data-id': w.id },
        h('div', { class: 'ed-box-label' }, (window.Widgets[w.type]?.name || w.type) + (w.label ? ' · ' + w.label : '')),
        h('div', { class: 'ed-resize' }));
      place(box, w.x, w.y, w.w, w.h, m);
      box.addEventListener('pointerdown', (e) => startDrag(e, w, box, e.target.classList.contains('ed-resize') ? 'resize' : 'move'));
      overlay.append(box);
    }
  }

  function place(box, x, y, w, hh, m = metrics()) {
    box.style.left = m.left(x) + 'px';
    box.style.top = m.top(y) + 'px';
    box.style.width = m.width(w) + 'px';
    box.style.height = m.height(hh) + 'px';
  }

  function startDrag(e, w, box, kind) {
    e.preventDefault();
    e.stopPropagation();
    select(w.id, false);
    document.querySelectorAll('.ed-box').forEach((b) => b.classList.toggle('selected', b === box));
    const m = metrics();
    const sx = e.clientX;
    const sy = e.clientY;
    let nx = w.x, ny = w.y, nw = w.w, nh = w.h;
    box.classList.add('dragging');

    const move = (ev) => {
      const dx = (ev.clientX - sx) / E.scale;
      const dy = (ev.clientY - sy) / E.scale;
      if (kind === 'move') {
        nx = Math.max(0, Math.min(m.g.cols - w.w, Math.round(w.x + dx / (m.cw + m.g.gap))));
        ny = Math.max(0, Math.min(m.g.rows - w.h, Math.round(w.y + dy / (m.ch + m.g.gap))));
      } else {
        nw = Math.max(1, Math.min(m.g.cols - w.x, Math.round(w.w + dx / (m.cw + m.g.gap))));
        nh = Math.max(1, Math.min(m.g.rows - w.y, Math.round(w.h + dy / (m.ch + m.g.gap))));
      }
      place(box, nx, ny, nw, nh, m);
      box.classList.toggle('invalid', overlaps(curPage(), w, nx, ny, nw, nh));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box.classList.remove('dragging');
      const changed = nx !== w.x || ny !== w.y || nw !== w.w || nh !== w.h;
      if (changed && !overlaps(curPage(), w, nx, ny, nw, nh)) {
        Object.assign(w, { x: nx, y: ny, w: nw, h: nh });
        markDirty();
        renderCanvas();
      } else {
        place(box, w.x, w.y, w.w, w.h, m);
        box.classList.remove('invalid');
      }
      renderInspector();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function select(id, rerender = true) {
    E.selected = id;
    E.view = 'widget';
    if (rerender) renderOverlay();
    renderInspector();
  }

  function renderAll() {
    renderTabs();
    renderCanvas();
    renderInspector();
    fit();
  }

  // ---------- Widgets and pages ----------
  function freeSpot(page, ww, hh) {
    const g = EdgeDeck.gridFor(page, E.cfg);
    for (let y = 0; y <= g.rows - hh; y++) {
      for (let x = 0; x <= g.cols - ww; x++) {
        if (!overlaps(page, { id: null }, x, y, ww, hh)) return { x, y };
      }
    }
    return null;
  }

  function addWidget(type, base = null) {
    const def = window.Widgets[type];
    const page = curPage();
    let [ww, hh] = base ? [base.w, base.h] : def.size;
    let spot = freeSpot(page, ww, hh);
    if (!spot && (ww > 1 || hh > 1)) { ww = 1; hh = 1; spot = freeSpot(page, 1, 1); }
    if (!spot) return EdgeDeck.toast('No free space on this page', 'error');
    const w = base ? JSON.parse(JSON.stringify(base)) : { type };
    Object.assign(w, { id: EdgeDeck.newId(), type, x: spot.x, y: spot.y, w: ww, h: hh });
    if (!base) for (const p of def.props) if (p.default !== undefined && w[p.key] === undefined) w[p.key] = p.default;
    if (type === 'key' && !base) w.label = 'New key';
    page.widgets.push(w);
    markDirty();
    E.selected = w.id;
    renderCanvas();
    renderInspector();
  }

  function deleteWidget(w) {
    const page = curPage();
    page.widgets = page.widgets.filter((o) => o.id !== w.id);
    E.selected = null;
    markDirty();
    renderCanvas();
    renderInspector();
  }

  function addPage() {
    if (onMeeting()) E.page = 0;
    E.cfg.pages.push({ name: `Page ${E.cfg.pages.length + 1}`, widgets: [] });
    E.page = E.cfg.pages.length - 1;
    E.selected = null;
    E.view = 'widget';
    markDirty();
    renderAll();
  }

  // ---------- Inspector ----------
  let rerenderTimer;
  function changed(rebuildForm = false) {
    markDirty();
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(renderCanvas, 250);
    if (rebuildForm) renderInspector();
  }

  function confirmButton(label, onConfirm, cls = 'danger') {
    const b = h('button', { class: 'ed-btn ' + cls }, label);
    let armed = false;
    b.addEventListener('click', () => {
      if (armed) return onConfirm();
      armed = true;
      b.textContent = 'Click again to confirm';
      setTimeout(() => { armed = false; b.textContent = label; }, 3000);
    });
    return b;
  }

  function field(label, control, hint) {
    return h('label', { class: 'ed-field' }, h('span', { class: 'ed-label' }, label), control, hint ? h('small', { class: 'ed-hint' }, hint) : null);
  }

  function control(prop, obj, onChange) {
    const val = obj[prop.key] !== undefined ? obj[prop.key] : prop.default;
    const set = (v, rebuild) => { obj[prop.key] = v; onChange(rebuild); };
    switch (prop.type) {
      case 'bool': {
        const c = h('input', { type: 'checkbox' });
        c.checked = val !== false && val !== undefined && val !== '';
        if (val === undefined) c.checked = prop.default === true;
        c.addEventListener('change', () => set(c.checked, true));
        return h('label', { class: 'ed-check' }, c, h('span', {}, prop.label));
      }
      case 'select': {
        const s = h('select', {}, prop.options.map(([v, l]) => h('option', { value: v }, l)));
        s.value = val ?? prop.options[0][0];
        if (val === undefined) obj[prop.key] = s.value;
        s.addEventListener('change', () => set(s.value, true));
        return field(prop.label, s, prop.hint);
      }
      case 'number': {
        const i = h('input', { type: 'number', min: prop.min, max: prop.max, step: prop.step || 1 });
        i.value = val ?? '';
        i.addEventListener('input', () => set(i.value === '' ? undefined : Number(i.value)));
        return field(prop.label, i, prop.hint);
      }
      case 'textarea': {
        const t = h('textarea', { rows: 3, placeholder: prop.placeholder || '', spellcheck: 'false' });
        t.value = val ?? '';
        t.addEventListener('input', () => set(t.value));
        return field(prop.label, t, prop.hint);
      }
      case 'color': {
        const c = h('input', { type: 'color' });
        c.value = val || '#14171c';
        c.addEventListener('input', () => set(c.value));
        const clear = h('button', { class: 'ed-btn small', onclick: (e) => { e.preventDefault(); set(undefined, true); } }, 'Default');
        return field(prop.label, h('div', { class: 'ed-row' }, c, clear), prop.hint);
      }
      case 'app': {
        const s = h('select', {}, h('option', { value: '' }, E.apps ? 'Choose an app…' : 'Loading apps…'));
        const fill = () => {
          s.innerHTML = '';
          s.append(h('option', { value: '' }, 'Choose an app…'));
          const list = E.apps || [];
          if (val && !list.some((a) => a.id === val)) s.append(h('option', { value: val }, val));
          for (const a of list) s.append(h('option', { value: a.id }, a.name));
          s.value = val || '';
        };
        if (E.apps) fill();
        else loadApps().then(fill);
        s.addEventListener('change', () => {
          const app = (E.apps || []).find((a) => a.id === s.value);
          const prev = (E.apps || []).find((a) => a.id === obj[prop.key]);
          if (app && (!obj.label || obj.label === 'New key' || (prev && obj.label === prev.name))) obj.label = app.name;
          set(s.value, true);
        });
        return field(prop.label, s, prop.hint);
      }
      case 'shortcut': {
        const listId = 'dl-shortcuts';
        const i = h('input', { type: 'text', list: listId, placeholder: 'Shortcut name' });
        i.value = val ?? '';
        i.addEventListener('input', () => set(i.value));
        const dl = h('datalist', { id: listId });
        loadShortcuts().then((names) => names.forEach((n) => dl.append(h('option', { value: n }))));
        return field(prop.label, h('div', {}, i, dl), 'From the Shortcuts app.');
      }
      case 'entity': {
        const listId = 'dl-ent-' + Math.random().toString(36).slice(2);
        const i = h('input', { type: 'text', list: listId, placeholder: 'light.living_room', spellcheck: 'false' });
        i.value = val ?? '';
        const dl = h('datalist', { id: listId });
        const ids = Object.keys(HA.states).filter((id) => !prop.domain || id.startsWith(prop.domain + '.')).sort();
        for (const id of ids) dl.append(h('option', { value: id }, HA.states[id].attributes.friendly_name || id));
        const hint = h('small', { class: 'ed-hint' });
        const showHint = () => {
          const st = HA.states[i.value];
          hint.textContent = HA.status !== 'connected'
            ? 'Home Assistant ' + HA.status + ' — set it up under Settings to pick from a list.'
            : st ? (st.attributes.friendly_name || '') + ' · ' + st.state : (i.value ? 'Entity not found' : `${ids.length} entities available`);
        };
        showHint();
        i.addEventListener('input', () => { set(i.value.trim()); showHint(); });
        return h('label', { class: 'ed-field' }, h('span', { class: 'ed-label' }, prop.label), i, dl, hint);
      }
      case 'dynamic': {
        const s = h('select', {}, h('option', { value: val || '' }, val || 'Loading…'));
        s.value = val || '';
        const hint = h('small', { class: 'ed-hint' }, prop.hint || '');
        Promise.resolve(prop.load()).then((opts) => {
          s.innerHTML = '';
          if (!val) s.append(h('option', { value: '' }, 'Choose…'));
          if (val && !opts.some(([v]) => v === val)) s.append(h('option', { value: val }, val + ' (not found)'));
          for (const [v, l] of opts) s.append(h('option', { value: v }, l));
          s.value = val || '';
        }).catch((e) => { hint.textContent = e.message + (prop.hint ? ' — ' + prop.hint : ''); });
        s.addEventListener('change', () => set(s.value, true));
        return h('label', { class: 'ed-field' }, h('span', { class: 'ed-label' }, prop.label), s, hint);
      }
      case 'checklist': {
        const chosen = new Set(Array.isArray(val) ? val : []);
        const box = h('div', { class: 'ed-checklist' }, 'Loading…');
        const hint = h('small', { class: 'ed-hint' }, prop.hint || '');
        Promise.resolve(prop.load()).then((opts) => {
          box.innerHTML = '';
          // Keep chosen items that aren't currently available (e.g. an app not in the Dock right now).
          const all = [...opts, ...[...chosen].filter((v) => !opts.some(([o]) => o === v)).map((v) => [v, v + ' (not in Dock)'])];
          if (!all.length) box.textContent = 'Nothing to choose from';
          for (const [v, l] of all) {
            const c = h('input', { type: 'checkbox' });
            c.checked = chosen.has(v);
            c.addEventListener('change', () => {
              if (c.checked) chosen.add(v); else chosen.delete(v);
              // Keep the order of the list.
              set(all.map(([o]) => o).filter((o) => chosen.has(o)), true);
            });
            box.append(h('label', { class: 'ed-check' }, c, h('span', {}, l)));
          }
        }).catch((e) => { box.textContent = ''; hint.textContent = e.message; });
        return h('div', { class: 'ed-field' }, h('span', { class: 'ed-label' }, prop.label), box, hint);
      }
      case 'labelmap': {
        // One text box per item chosen in another field (prop.from), e.g. a label per app.
        // Stored as {value: label}; an empty box falls back to the placeholder.
        const map = Object.assign({}, val || {});
        const ids = Array.isArray(obj[prop.from]) ? obj[prop.from] : [];
        const box = h('div', { class: 'ed-labelmap' });
        const hint = h('small', { class: 'ed-hint' }, prop.hint || '');
        Promise.resolve(prop.load()).then((opts) => {
          const info = new Map(opts.map(([v, name, short]) => [v, { name, short }]));
          for (const id of ids) {
            const meta = info.get(id) || { name: id, short: id.split('.').pop() };
            const i = h('input', { type: 'text', placeholder: meta.short, spellcheck: 'false' });
            i.value = map[id] || '';
            i.addEventListener('input', () => {
              if (i.value.trim()) map[id] = i.value; else delete map[id];
              set(Object.assign({}, map));
            });
            box.append(h('label', { class: 'ed-labelmap-row' }, h('span', {}, meta.name), i));
          }
        }).catch((e) => { hint.textContent = e.message; });
        return h('div', { class: 'ed-field' }, h('span', { class: 'ed-label' }, prop.label), box, hint);
      }
      case 'page': {
        // Stored as the page name so it survives reordering; older configs may hold a page number.
        const s = h('select', {}, E.cfg.pages.map((p, n) => h('option', { value: p.name }, `${n + 1}. ${p.name}`)));
        const byNumber = /^\d+$/.test(String(val || '')) ? E.cfg.pages[Number(val) - 1] : null;
        s.value = byNumber ? byNumber.name : (val || (E.cfg.pages[0] && E.cfg.pages[0].name) || '');
        if (!val) obj[prop.key] = s.value;
        s.addEventListener('change', () => set(s.value));
        return field(prop.label, s, prop.hint);
      }
      default: {
        const i = h('input', { type: prop.type === 'password' ? 'password' : 'text', placeholder: prop.placeholder || '', spellcheck: 'false' });
        i.value = val ?? '';
        i.addEventListener('input', () => set(i.value));
        return field(prop.label, i, prop.hint);
      }
    }
  }

  function renderInspector() {
    const panel = document.querySelector('.ed-inspector');
    panel.innerHTML = '';
    const w = selectedWidget();
    if (!w) return renderPagePanel(panel);

    const def = window.Widgets[w.type];
    const props = def.props.filter((p) => !p.showIf || p.showIf(w));
    const fixed = onMeeting() && w.type === 'teams';   // the meeting page's own controls
    const moveTo = onMeeting() ? null : h('select', {}, h('option', { value: '' }, 'Move to page…'),
      E.cfg.pages.map((p, n) => (n === E.page ? null : h('option', { value: n }, p.name))));
    if (moveTo) moveTo.addEventListener('change', () => {
      const target = E.cfg.pages[Number(moveTo.value)];
      const spot = freeSpot(target, w.w, w.h);
      if (!spot) { EdgeDeck.toast('No room on that page', 'error'); moveTo.value = ''; return; }
      curPage().widgets = curPage().widgets.filter((o) => o !== w);
      Object.assign(w, spot);
      target.widgets.push(w);
      E.page = Number(moveTo.value);
      markDirty();
      renderAll();
    });

    panel.append(
      h('div', { class: 'ed-panel-head' },
        h('h2', {}, def.name),
        h('span', { class: 'ed-meta' }, `Column ${w.x + 1}, row ${w.y + 1} · ${w.w} × ${w.h}`),
        h('div', { class: 'ed-spacer' }),
        moveTo,
        fixed ? h('span', { class: 'ed-meta' }, 'The meeting page always keeps its controls') : null,
        fixed ? null : h('button', { class: 'ed-btn', onclick: () => addWidget(w.type, w) }, 'Duplicate'),
        fixed ? null : h('button', { class: 'ed-btn danger', onclick: () => deleteWidget(w) }, 'Delete')),
      h('div', { class: 'ed-form' }, props.map((p) => control(p, w, (rebuild) => changed(rebuild)))));
  }

  // Grid controls for a profile (all its pages) or the meeting page.
  function gridSection(title, grid) {
    const changedGrid = () => { EdgeDeck.clampToGrid(E.cfg); changed(); renderOverlay(); };
    return h('div', { class: 'ed-section' }, h('h3', {}, title), h('div', { class: 'ed-form' },
      control({ key: 'cols', label: 'Columns', type: 'number', min: 4, max: 30 }, grid, changedGrid),
      control({ key: 'rows', label: 'Rows', type: 'number', min: 1, max: 10 }, grid, changedGrid),
      control({ key: 'gap', label: 'Gap between tiles (px)', type: 'number', min: 0, max: 60 }, grid, changedGrid),
      control({ key: 'padding', label: 'Edge padding (px)', type: 'number', min: 0, max: 80 }, grid, changedGrid),
      h('small', { class: 'ed-hint' }, 'If you make the grid smaller, widgets that no longer fit are moved in and shrunk.')));
  }

  function renderMeetingPanel(panel) {
    panel.append(
      h('div', { class: 'ed-panel-head' }, h('h2', {}, '👥 Meeting page'), h('span', { class: 'ed-meta' }, `${E.cfg.meeting.widgets.length} widgets`)),
      h('div', { class: 'ed-help' },
        h('p', {}, 'Shown on the Edge during Teams and Zoom meetings, whichever profile you’re using, and taken away afterwards.'),
        h('p', {}, 'Arrange anything you like around the meeting controls, which always stay on this page.')),
      gridSection('Meeting page grid', E.cfg.meeting.grid));
  }

  function renderPagePanel(panel) {
    if (onMeeting()) return renderMeetingPanel(panel);
    const page = curPage();
    const name = h('input', { type: 'text' });
    name.value = page.name;
    name.addEventListener('input', () => { page.name = name.value; markDirty(); renderTabs(); });
    const move = (d) => {
      const i = E.page, j = i + d;
      if (j < 0 || j >= E.cfg.pages.length) return;
      [E.cfg.pages[i], E.cfg.pages[j]] = [E.cfg.pages[j], E.cfg.pages[i]];
      E.page = j;
      markDirty();
      renderAll();
    };
    panel.append(
      h('div', { class: 'ed-panel-head' },
        h('h2', {}, 'Page'),
        h('span', { class: 'ed-meta' }, `${page.widgets.length} widgets`),
        h('div', { class: 'ed-spacer' }),
        h('button', { class: 'ed-btn', onclick: () => move(-1), disabled: E.page === 0 }, '← Move left'),
        h('button', { class: 'ed-btn', onclick: () => move(1), disabled: E.page === E.cfg.pages.length - 1 }, 'Move right →'),
        E.cfg.pages.length > 1 ? confirmButton('Delete page', () => {
          E.cfg.pages.splice(E.page, 1);
          E.page = Math.max(0, E.page - 1);
          markDirty();
          renderAll();
        }) : null),
      h('div', { class: 'ed-form' },
        field('Page name', name),
        control({
          key: 'showWhenApps', label: 'Show this page when one of these apps is in front', type: 'checklist',
          load: async () => (await loadApps()).map((a) => [a.id, a.name]),
          hint: 'Optional. The Edge switches to this page while the app is in front, then back again. Not during meetings.',
        }, page, () => { markDirty(); renderTabs(); }),
        h('div', { class: 'ed-help' },
          h('p', {}, 'Click a widget to edit it. Drag to move, drag the corner to resize. Add widgets with “+ Add widget”.'),
          h('p', {}, 'On the Edge, swipe left or right to change page. Keys: Delete removes the selected widget, ⌘D duplicates, arrow keys nudge, ⌘S saves.'))),
      gridSection(`Grid for “${profile().name}”`, profile().grid));
  }

  function loadApps() {
    if (E.appsPromise) return E.appsPromise;
    E.appsPromise = EdgeBridge.call('apps.list').then((a) => (E.apps = a || [])).catch(() => (E.apps = []));
    return E.appsPromise;
  }
  function loadShortcuts() {
    if (E.shortcutsPromise) return E.shortcutsPromise;
    E.shortcutsPromise = EdgeBridge.call('shortcuts.list').then((s) => (E.shortcuts = s || [])).catch(() => []);
    return E.shortcutsPromise;
  }

  // ---------- Save / keys ----------
  async function save() {
    try {
      await EdgeBridge.call('config.update', { section: '*', json: JSON.stringify({ profiles: E.cfg.profiles, activeProfile: E.cfg.activeProfile, meeting: E.cfg.meeting }) });
      markDirty(false);
      EdgeDeck.toast('Saved — the Edge has been updated');
    } catch (e) {
      EdgeDeck.toast('Save failed: ' + e.message, 'error');
    }
  }

  function onKey(e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); return; }
    if (typing) return;
    const w = selectedWidget();
    if (!w) return;
    const fixed = onMeeting() && w.type === 'teams';
    if ((e.key === 'Delete' || e.key === 'Backspace') && !fixed) { e.preventDefault(); deleteWidget(w); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'd' && !fixed) { e.preventDefault(); addWidget(w.type, w); }
    else if (e.key === 'Escape') select(null);
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const g = curGrid();
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const nx = Math.max(0, Math.min(g.cols - w.w, w.x + d[0]));
      const ny = Math.max(0, Math.min(g.rows - w.h, w.y + d[1]));
      if (!overlaps(curPage(), w, nx, ny, w.w, w.h)) {
        w.x = nx; w.y = ny;
        markDirty();
        renderCanvas();
        renderInspector();
      }
    }
  }

  // Form building blocks, shared with the Settings window.
  window.EditorForm = {
    h, field, control,
    useConfig(cfg) { E.cfg = cfg; },   // some controls (e.g. page pickers) read the page list
  };

  window.Editor = {
    start(cfg) {
      E.cfg = cfg;
      HA.configure(cfg.homeAssistant.url, cfg.homeAssistant.token);
      build();
      renderAll();
      loadApps();
    },
    get state() { return E; },
    // Everything except the pages belongs to Settings (and the dashboard, for
    // calibration): take those parts from the saved config and redraw.
    syncSettings(fresh) {
      if (!E.cfg) return;
      const layout = ['profiles', 'activeProfile', 'meeting', 'pages', 'grid'];
      for (const key of Object.keys(fresh)) if (!layout.includes(key)) E.cfg[key] = fresh[key];
      // The profile was switched from the menu bar or a key: follow it unless there are unsaved edits here.
      if (fresh.activeProfile !== E.cfg.activeProfile && !E.dirty) {
        E.cfg.profiles = fresh.profiles;
        E.cfg.meeting = fresh.meeting;
        EdgeDeck.selectProfile(E.cfg, fresh.activeProfile);
        if (!onMeeting()) E.page = 0;
        E.selected = null;
      }
      EdgeDeck.clampToGrid(E.cfg);
      HA.configure(E.cfg.homeAssistant.url, E.cfg.homeAssistant.token);
      renderAll();
    },
  };
})();
