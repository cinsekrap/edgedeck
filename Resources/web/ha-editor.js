// Home Assistant in the editor: the entity picker (search, type chips, grouped by
// area, live state), the controls built on it (one entity, several entities, an
// area, a key's action with its options), shared with Setup.
(function () {
  const h = (...a) => window.EditorForm.h(...a);
  const domainOf = (id) => String(id || '').split('.')[0];
  const words = (s) => String(s || '').toLowerCase().split(/\s+/).filter(Boolean);
  const NO_AREA = '￿';   // sorts "No area" last

  // An icon element for an entity (MDI glyph or emoji).
  function iconEl(id, cls = 'hap-icon') {
    const el = h('span', { class: cls });
    HA.setIcon(el, id);
    return el;
  }

  // Calls fn on Home Assistant changes until el leaves the page.
  function live(el, fn) {
    const unsub = HA.subscribe((id) => {
      if (!el.isConnected) { unsub(); return; }
      fn(id);
    });
  }

  // ---------- The picker ----------
  // opts: { title, multi, selected: [ids], types: [type keys] (first = chip shown first),
  //         domains: [only these] }. Resolves to an array of ids, or null if cancelled.
  function pick(opts = {}) {
    return new Promise((resolve) => {
      const multi = !!opts.multi;
      const strict = Array.isArray(opts.domains) && opts.domains.length ? opts.domains : null;
      const chosen = new Set(opts.selected || []);
      const order = [...(opts.selected || [])];
      let type = strict ? 'all' : (opts.types && opts.types[0]) || 'all';
      let showClutter = false;
      let query = '';

      const search = h('input', { type: 'text', class: 'hap-search', placeholder: 'Search by name, area or ID', spellcheck: 'false' });
      const chipBox = h('div', { class: 'hap-chips' });
      const list = h('div', { class: 'hap-list' });
      const clutterBox = h('label', { class: 'ed-check hap-clutter' });
      const addBtn = multi ? h('button', { class: 'ed-btn primary' }) : null;
      const overlay = h('div', { class: 'ed-dialog-backdrop' },
        h('div', { class: 'ed-dialog hap' },
          h('h3', {}, opts.title || (multi ? 'Choose entities' : 'Choose an entity')),
          search, chipBox, list,
          h('div', { class: 'hap-foot' }, clutterBox, h('span', { class: 'ed-spacer' }),
            h('button', { class: 'ed-btn', onclick: () => close(null) }, 'Cancel'), addBtn)));
      const close = (v) => { overlay.remove(); resolve(v); };
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && !multi) {
          const first = list.querySelector('.hap-row');
          if (first) first.click();
        }
      });
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(null); });
      if (addBtn) addBtn.addEventListener('click', () => close(order.filter((id) => chosen.has(id))));

      const stateEls = new Map();
      const all = () => HA.entityList().filter((e) => !strict || strict.includes(e.domain));
      const updateAdd = () => {
        if (!addBtn) return;
        const n = order.filter((id) => chosen.has(id)).length;
        addBtn.textContent = n ? `Use ${n} selected` : 'Use none';
      };

      function render() {
        const keepScroll = list.scrollTop;
        stateEls.clear();
        if (HA.status !== 'connected') {
          const info = HA.statusInfo();
          chipBox.replaceChildren();
          clutterBox.replaceChildren();
          list.replaceChildren(h('div', { class: 'hap-empty' },
            h('p', {}, info.text), info.hint ? h('p', { class: 'ed-hint' }, info.hint) : null,
            h('button', { class: 'ed-btn', onclick: () => EdgeBridge.call('settings.open') }, 'Open Settings…'),
            h('p', { class: 'ed-hint' }, 'You can still type an entity ID in the search box and press Return.')));
          typedRow();
          return;
        }
        const ents = all();
        const clutterCount = ents.filter((e) => e.clutter).length;
        const visible = ents.filter((e) => showClutter || !e.clutter || chosen.has(e.id));

        // Type chips with counts (not narrowed by the search, so they don't jump about).
        if (!strict) {
          const counts = new Map();
          for (const e of visible) counts.set(e.type, (counts.get(e.type) || 0) + 1);
          const chips = [['all', 'All', visible.length], ...HA.TYPES.filter(([k]) => counts.get(k)).map(([k, l]) => [k, l, counts.get(k)])];
          if (!chips.some(([k]) => k === type)) type = 'all';
          chipBox.replaceChildren(...chips.map(([k, l, n]) =>
            h('button', { class: 'hap-chip' + (k === type ? ' on' : ''), onclick: () => { type = k; render(); search.focus(); } }, l, h('span', { class: 'hap-count' }, String(n)))));
        } else chipBox.replaceChildren();

        clutterBox.replaceChildren();
        if (clutterCount) {
          const c = h('input', { type: 'checkbox' });
          c.checked = showClutter;
          c.addEventListener('change', () => { showClutter = c.checked; render(); });
          clutterBox.append(c, h('span', {}, `Show hidden and diagnostic entities (${clutterCount})`));
        }

        const q = words(query);
        const shown = visible.filter((e) => (type === 'all' || e.type === type) &&
          q.every((w) => (e.name + ' ' + e.id + ' ' + e.area).toLowerCase().includes(w)));

        const rows = [];
        if (!shown.length) rows.push(h('div', { class: 'hap-empty' }, query ? 'Nothing matches “' + query + '”.' : 'Nothing of this type.'));
        // Grouped by area when Home Assistant shares its areas.
        // opts.first {domains, label}: the likeliest choices get their own group at the top.
        const FIRST = '\u0000';
        const isFirst = (e) => opts.first && opts.first.domains.includes(e.id.split('.')[0]);
        const groups = new Map();
        for (const e of shown) {
          const k = isFirst(e) ? FIRST : HA.hasRegistry ? (e.area || NO_AREA) : '';
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(e);
        }
        const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
        const labelled = HA.hasRegistry || groups.has(FIRST);
        for (const k of keys) {
          if (labelled) rows.push(h('div', { class: 'hap-group' }, k === FIRST ? opts.first.label : k === NO_AREA ? 'No area' : k || 'Everything else'));
          for (const e of groups.get(k).sort((a, b) => a.name.localeCompare(b.name))) rows.push(row(e));
        }
        list.replaceChildren(...rows);
        typedRow();
        list.scrollTop = keepScroll;
        updateAdd();
      }

      // Typing a full entity ID that isn't listed (Home Assistant offline, or not loaded yet).
      function typedRow() {
        const id = query.trim();
        if (!/^[a-z_]+\.[a-z0-9_]+$/.test(id) || HA.states[id]) return;
        if (strict && !strict.includes(domainOf(id))) return;
        list.prepend(h('div', { class: 'hap-row', onclick: () => choose(id) }, h('span', { class: 'hap-icon' }, '＋'),
          h('div', { class: 'hap-text' }, h('div', { class: 'hap-name' }, 'Use “' + id + '”'), h('div', { class: 'hap-id' }, 'Not in Home Assistant’s list right now'))));
      }

      function choose(id) {
        if (!multi) return close([id]);
        if (chosen.has(id)) chosen.delete(id);
        else { chosen.add(id); if (!order.includes(id)) order.push(id); }
        render();
      }

      function row(e) {
        const st = HA.states[e.id];
        const state = h('span', { class: 'hap-state' }, HA.describe(st));
        stateEls.set(e.id, state);
        const sel = chosen.has(e.id);
        const r = h('div', { class: 'hap-row' + (sel ? ' selected' : '') + (e.clutter ? ' clutter' : ''), onclick: () => choose(e.id), title: e.id },
          multi ? h('input', { type: 'checkbox', tabindex: '-1' }) : null,
          iconEl(e.id),
          h('div', { class: 'hap-text' }, h('div', { class: 'hap-name' }, e.name), h('div', { class: 'hap-id' }, e.id)),
          state);
        if (multi) r.querySelector('input').checked = sel;
        return r;
      }

      let renderTimer = null;
      search.addEventListener('input', () => {
        query = search.value;
        clearTimeout(renderTimer);
        renderTimer = setTimeout(render, 80);
      });
      live(overlay, (id) => {
        if (id === '*') return render();
        const el = stateEls.get(id);
        if (el) el.textContent = HA.describe(HA.states[id]);
      });
      document.body.append(overlay);
      render();
      search.focus();
    });
  }

  // ---------- One entity ----------
  function entityControl(prop, obj, set, val) {
    const cur = h('button', { type: 'button', class: 'hap-field' });
    const clear = h('button', { type: 'button', class: 'ed-btn small', title: 'Clear' }, '✕');
    const hint = h('small', { class: 'ed-hint' }, prop.hint || '');
    const show = () => {
      const id = obj[prop.key] || '';
      const st = HA.states[id];
      clear.style.display = id ? '' : 'none';
      if (!id) {
        cur.replaceChildren(h('span', { class: 'hap-icon' }, '＋'), h('div', { class: 'hap-text' }, h('div', { class: 'hap-name' }, 'Choose…')));
        return;
      }
      const where = HA.status !== 'connected' ? 'Home Assistant ' + HA.status
        : !st ? 'Not found in Home Assistant' : [HA.describe(st), HA.areaName(HA.areaOf(id))].filter(Boolean).join(' · ');
      cur.replaceChildren(iconEl(id), h('div', { class: 'hap-text' }, h('div', { class: 'hap-name' }, HA.name(id)), h('div', { class: 'hap-id' }, id + ' · ' + where)),
        h('span', { class: 'hap-change' }, 'Change…'));
      cur.classList.toggle('missing', HA.status === 'connected' && !st);
    };
    cur.addEventListener('click', async (e) => {
      e.preventDefault();
      const r = await pick({ title: prop.label, types: prop.types, domains: prop.domains, first: prop.first, selected: obj[prop.key] ? [obj[prop.key]] : [] });
      if (r && r[0]) { set(r[0], true); show(); }   // the editor redraws anyway; Settings doesn't
    });
    clear.addEventListener('click', (e) => { e.preventDefault(); set('', true); show(); });
    show();
    const wrap = h('div', { class: 'ed-field hap-entity' }, h('span', { class: 'ed-label' }, prop.label), h('div', { class: 'ed-row hap-field-row' }, cur, clear), hint);
    live(wrap, (id) => { if (id === '*' || id === obj[prop.key]) show(); });
    return wrap;
  }

  // ---------- Several entities, in order ----------
  function entitiesControl(prop, obj, set) {
    const box = h('div', { class: 'hap-multi' });
    const ids = () => (Array.isArray(obj[prop.key]) ? obj[prop.key] : []);
    const put = (list) => set(list, true);
    const show = () => {
      const list = ids();
      const rows = list.map((id, i) => h('div', { class: 'hap-multi-row' },
        iconEl(id),
        h('div', { class: 'hap-text' }, h('div', { class: 'hap-name' }, HA.name(id)), h('div', { class: 'hap-id' }, id + (HA.states[id] ? ' · ' + HA.describe(HA.states[id]) : HA.status === 'connected' ? ' · not found' : ''))),
        h('button', { type: 'button', class: 'ed-btn small', title: 'Move up', disabled: i === 0, onclick: (e) => { e.preventDefault(); const l = [...list]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; put(l); } }, '↑'),
        h('button', { type: 'button', class: 'ed-btn small', title: 'Move down', disabled: i === list.length - 1, onclick: (e) => { e.preventDefault(); const l = [...list]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; put(l); } }, '↓'),
        h('button', { type: 'button', class: 'ed-btn small', title: 'Remove', onclick: (e) => { e.preventDefault(); put(list.filter((x) => x !== id)); } }, '✕')));
      box.replaceChildren(...rows, h('button', {
        type: 'button', class: 'ed-btn', onclick: async (e) => {
          e.preventDefault();
          const r = await pick({ title: prop.label, multi: true, types: prop.types, domains: prop.domains, selected: ids() });
          if (r) put(r);
        },
      }, list.length ? 'Add or remove…' : 'Choose…'));
    };
    show();
    const wrap = h('div', { class: 'ed-field hap-wide' }, h('span', { class: 'ed-label' }, prop.label), box, prop.hint ? h('small', { class: 'ed-hint' }, prop.hint) : null);
    live(wrap, (id) => { if (id === '*') show(); });
    return wrap;
  }

  // ---------- An area ----------
  function areaControl(prop, obj, set, val) {
    const s = h('select');
    const hint = h('small', { class: 'ed-hint' });
    const fill = () => {
      const areas = HA.sortedAreas();
      s.replaceChildren(h('option', { value: '' }, 'Choose an area…'),
        ...(val && !HA.areas.has(val) ? [h('option', { value: val }, val + (HA.status === 'connected' ? ' (not found)' : ''))] : []),
        ...areas.map((a) => {
          const n = HA.areaEntities(a.id, ['light']).length;
          return h('option', { value: a.id }, a.name + (n ? ` · ${n} light${n === 1 ? '' : 's'}` : ''));
        }));
      s.value = val || '';
      hint.textContent = HA.status !== 'connected' ? 'Home Assistant ' + HA.status + ': set it up under Settings.'
        : !HA.hasRegistry ? 'Home Assistant didn’t share its areas with EdgeDeck (they need an administrator’s token).' : '';
    };
    s.addEventListener('change', () => set(s.value, true));
    fill();
    const wrap = h('label', { class: 'ed-field' }, h('span', { class: 'ed-label' }, prop.label), s, hint);
    live(wrap, (id) => { if (id === '*') fill(); });
    return wrap;
  }

  // ---------- A key's action ----------
  // The entity's own services first (toggle, turn on…), then Home Assistant's generic
  // ones; "Other…" takes any service. Options the chosen service takes (brightness,
  // temperature…) appear underneath; empty ones aren't sent.
  const FIRST = ['toggle', 'turn_on', 'turn_off', 'press', 'trigger', 'lock', 'unlock', 'open_cover', 'close_cover', 'stop_cover', 'media_play_pause', 'set_temperature', 'set_hvac_mode'];
  const human = (svc) => svc.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  function serviceControl(prop, obj, set) {
    const wrap = h('div', { class: 'ed-field hap-wide hap-service' });
    const entity = obj[prop.entityKey] || '';
    const domain = domainOf(entity);
    const dataKey = prop.dataKey;
    const label = h('span', { class: 'ed-label' }, prop.label);
    wrap.append(label, h('small', { class: 'ed-hint' }, 'Loading Home Assistant’s actions…'));

    const draw = (services) => {
      const cur = obj[prop.key] || '';
      const own = entity && services[domain] ? Object.entries(services[domain]) : [];
      own.sort(([a], [b]) => ((FIRST.indexOf(a) + 1 || 99) - (FIRST.indexOf(b) + 1 || 99)) || a.localeCompare(b));
      const generic = entity && services.homeassistant
        ? ['toggle', 'turn_on', 'turn_off'].filter((x) => services.homeassistant[x] && !(services[domain] || {})[x]).map((x) => ['homeassistant.' + x, services.homeassistant[x]])
        : [];
      const options = [...own.map(([svc, d]) => [domain + '.' + svc, d]), ...generic];
      const known = options.some(([v]) => v === cur);
      // actionFor remembers which entity the action was picked for: choosing another
      // entity picks a fresh default. (Older keys don't have it; their service is kept.)
      const stale = obj.actionFor && obj.actionFor !== entity && obj.actionCustom !== true;
      if (known && !obj.actionFor) obj.actionFor = entity;   // so a later change of entity resets it
      const custom = !entity || obj.actionCustom === true || (cur && !known && !stale);

      // A sensible default as soon as an entity is chosen.
      if (entity && (!cur || stale) && options.length && !custom) {
        // Its own toggle, else its own first action (a lock: Lock, never Unlock), else a generic one.
        const def = options.find(([v]) => v === domain + '.toggle') || options[0];
        obj.actionFor = entity;
        obj[dataKey] = {};
        return set(def[0], true);
      }

      const kids = [label];
      if (entity) {
        const sel = h('select', {},
          ...options.map(([v, d]) => h('option', { value: v }, (d.name || human(v.split('.')[1])) + (v.startsWith('homeassistant.') ? ' (generic)' : ''))),
          h('option', { value: '__custom' }, 'Other service…'));
        sel.value = custom ? '__custom' : cur;
        sel.addEventListener('change', () => {
          if (sel.value === '__custom') { obj.actionCustom = true; set(cur, true); return; }
          obj.actionCustom = false;
          obj.actionFor = entity;
          obj[dataKey] = {};
          set(sel.value, true);
        });
        kids.push(sel);
      }
      if (custom) {
        const listId = 'dl-svc-' + Math.random().toString(36).slice(2);
        const input = h('input', { type: 'text', list: listId, placeholder: entity ? domain + '.turn_on' : 'script.goodnight', spellcheck: 'false' });
        input.value = cur;
        input.addEventListener('change', () => set(input.value.trim(), true));
        const dl = h('datalist', { id: listId }, ...Object.entries(services).flatMap(([d, svcs]) => Object.keys(svcs).map((s) => h('option', { value: d + '.' + s }))));
        kids.push(input, dl, h('small', { class: 'ed-hint' }, entity
          ? 'Any Home Assistant service, as domain.service. It’s called on the entity above.'
          : 'Choose an entity above to pick from its actions, or type any service, e.g. script.goodnight.'));
      }
      wrap.replaceChildren(...kids);

      // The service's options.
      const [d, svc] = (obj[prop.key] || '').split('.');
      const fields = (services[d] && services[d][svc] && services[d][svc].fields) || {};
      const data = Object.assign({}, obj[dataKey] || {});
      const rows = [];
      for (const [key, f] of Object.entries(fields)) {
        if (!f || f.fields || f.advanced || !f.selector) continue;   // collapsed sections and expert-only options
        const control = fieldControl(key, f, data[key], (v) => {
          if (v === '' || v == null) delete data[key]; else data[key] = v;
          obj[dataKey] = Object.assign({}, data);
          set(obj[prop.key], false);
        });
        if (control) rows.push(control);
      }
      // Drop options the newly chosen service doesn't take.
      for (const k of Object.keys(data)) if (!fields[k]) delete data[k];
      obj[dataKey] = data;
      if (rows.length) wrap.append(h('div', { class: 'hap-data' }, h('div', { class: 'hap-data-head' }, 'Options (leave empty to use Home Assistant’s defaults)'), ...rows));
    };

    HA.services().then(draw).catch(() => {
      // Offline: a plain text box still works.
      const input = h('input', { type: 'text', placeholder: 'light.toggle', spellcheck: 'false' });
      input.value = obj[prop.key] || '';
      input.addEventListener('change', () => set(input.value.trim(), true));
      wrap.replaceChildren(label, input, h('small', { class: 'ed-hint' }, 'Home Assistant ' + HA.status + ': type the service as domain.service, or set Home Assistant up under Settings to choose from a list.'));
    });
    return wrap;
  }

  // One option of a service, from its selector. Unsupported kinds are left out.
  function fieldControl(key, f, val, onChange) {
    const sel = f.selector;
    const name = (f.name || human(key)) + (f.required ? ' (required)' : '');
    const lbl = (control, hint) => h('label', { class: 'ed-field' }, h('span', { class: 'ed-label' }, name), control, hint ? h('small', { class: 'ed-hint' }, hint) : null);
    if (sel.number || sel.color_temp) {
      const n = sel.number || sel.color_temp;
      const kelvin = !!sel.color_temp;
      const min = kelvin ? n.min || n.min_kelvin || 2000 : n.min;
      const max = kelvin ? n.max || n.max_kelvin || 6500 : n.max;
      const i = h('input', { type: 'number', min, max, step: n.step === 'any' ? 'any' : n.step || (kelvin ? 50 : 1) });
      i.value = val ?? '';
      i.addEventListener('input', () => onChange(i.value === '' ? '' : Number(i.value)));
      const unit = kelvin ? 'K' : n.unit_of_measurement || '';
      return lbl(i, min != null && max != null ? `${min}–${max}${unit ? ' ' + unit : ''}` : unit);
    }
    if (sel.boolean) {
      const s = h('select', {}, h('option', { value: '' }, 'Default'), h('option', { value: 'true' }, 'Yes'), h('option', { value: 'false' }, 'No'));
      s.value = val === true ? 'true' : val === false ? 'false' : '';
      s.addEventListener('change', () => onChange(s.value === '' ? '' : s.value === 'true'));
      return lbl(s);
    }
    if (sel.select) {
      const opts = (sel.select.options || []).map((o) => (typeof o === 'object' ? [o.value, o.label || o.value] : [o, human(String(o))]));
      const s = h('select', {}, h('option', { value: '' }, 'Default'), ...opts.map(([v, l]) => h('option', { value: v }, l)));
      s.value = val ?? '';
      s.addEventListener('change', () => onChange(s.value));
      return lbl(s);
    }
    if (sel.text || sel.template) {
      const i = h('input', { type: 'text', spellcheck: 'false' });
      i.value = val ?? '';
      i.addEventListener('input', () => onChange(i.value));
      return lbl(i);
    }
    return null;
  }

  // Called by the editor's control() for the Home Assistant field types.
  function control(prop, obj, set, val) {
    switch (prop.type) {
      case 'entity': return entityControl(prop, obj, set, val);
      case 'entities': return entitiesControl(prop, obj, set);
      case 'haarea': return areaControl(prop, obj, set, val);
      case 'haservice': return serviceControl(prop, obj, set);
      default: return null;
    }
  }

  window.HAEditor = { pick, control };
})();
