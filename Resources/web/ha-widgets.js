// Home Assistant widgets: entity tile, camera, sensor glance, scene strip and area,
// plus the controls sheet that opens when you hold a tile.
(function () {
  const { makeSlider, throttle } = window.WidgetKit;

  const div = (cls, text) => {
    const e = document.createElement('div');
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const button = (cls, text, onTap) => {
    const b = document.createElement('button');
    b.className = cls + ' pressable';
    if (text != null) b.textContent = text;
    if (onTap) b._edgeTap = onTap;
    return b;
  };
  const domainOf = (id) => String(id || '').split('.')[0];
  const fail = (ctx) => (e) => ctx.toast(e.message, 'error');
  const isDimmable = (a) => a.brightness != null || (a.supported_color_modes || []).some((m) => m !== 'onoff');
  const round = (v, step) => Math.round(v / step) * step;
  const fmtTemp = (v) => {
    if (v == null || v === '' || isNaN(v)) return '–';
    const r = Math.round(Number(v) * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '°';
  };

  // A target temperature changed with − / + : shown at once, sent once the taps stop.
  function setpoint(ctx, id, onPending) {
    let pending = null, timer = null;
    const st = () => ctx.ha.states[id];
    return {
      get pending() { return pending; },
      bump(dir) {
        const s = st();
        if (!s) return;
        const a = s.attributes;
        const step = Number(a.target_temp_step) || ((a.max_temp || 0) > 40 ? 1 : 0.5);   // above 40: Fahrenheit
        const base = pending != null ? pending : Number(a.temperature);
        if (isNaN(base)) return ctx.toast('Set the temperature range in Home Assistant');
        pending = Math.max(a.min_temp ?? -100, Math.min(a.max_temp ?? 100, round(base + dir * step, step)));
        onPending(pending);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const value = pending;
          ctx.ha.callService(domainOf(id), 'set_temperature', id, { temperature: value })
            .catch(fail(ctx)).finally(() => { if (pending === value) { pending = null; onPending(null); } });
        }, 800);
      },
    };
  }

  // ---------------- Controls sheet ----------------
  // Opened by holding a tile. Closes on a tap outside, the ✕, or after 45 s untouched.
  function sheet(ctx, { title, sub, icon, watch, build, wide }) {
    document.querySelectorAll('.ha-backdrop').forEach((b) => b._close && b._close());
    const backdrop = div('ha-backdrop');
    const panel = div('ha-sheet' + (wide ? ' wide' : ''));
    panel._edgeTap = () => poke();   // taps on the panel itself don't close it
    backdrop.appendChild(panel);

    const head = div('ha-sheet-head');
    const iconEl = div('ha-sheet-icon');
    const titleEl = div('ha-sheet-title');
    const subEl = div('ha-sheet-sub');
    const text = div('ha-sheet-text');
    text.append(titleEl, subEl);
    const closeBtn = button('ha-close', '✕', () => close());
    head.append(iconEl, text, closeBtn);
    const body = div('ha-sheet-body');
    panel.append(head, body);

    let idle = null;
    const poke = () => { clearTimeout(idle); idle = setTimeout(close, 45000); };
    const refreshers = [];
    const api = {
      body,
      poke,
      close: () => close(),
      onState(fn) { refreshers.push(fn); },
      // Wraps a tap handler so it also keeps the sheet open.
      tap(el, fn) { el._edgeTap = () => { poke(); fn(); }; return el; },
    };
    const refresh = () => {
      titleEl.textContent = title();
      subEl.textContent = sub();
      icon(iconEl);
      for (const fn of refreshers) { try { fn(); } catch (e) { console.error(e); } }
    };
    const ids = new Set(watch);
    const unsub = ctx.ha.subscribe((id) => { if (id === '*' || ids.has(id)) refresh(); });
    function close() {
      clearTimeout(idle);
      unsub();
      backdrop.remove();
    }
    backdrop._close = close;
    backdrop._edgeTap = close;
    build(api);
    refresh();
    poke();
    document.body.appendChild(backdrop);
    return api;
  }

  // A wide bar that says what a tap will do ("Turn off"), lit while on.
  function toggleBar(api, ctx, id) {
    const bar = api.tap(button('ha-bar', ''), () => ctx.ha.callService(domainOf(id), 'toggle', id).catch(fail(ctx)));
    api.onState(() => {
      const st = ctx.ha.states[id];
      const on = !!st && ctx.ha.ON_STATES.has(st.state);
      bar.classList.toggle('on', on);
      bar.textContent = !st || st.state === 'unavailable' ? 'Unavailable' : on ? 'Turn off' : 'Turn on';
    });
    return bar;
  }

  // A big slider with its label and value above it.
  function bigSlider(api, { label, min, max, step = 1, get, format, send, cls = '' }) {
    const wrap = div('ha-control');
    const top = div('ha-control-top');
    const valueEl = div('ha-control-value');
    top.append(div('ha-control-label', label), valueEl);
    const slider = div('ha-big-slider slider ' + cls);
    slider.innerHTML = '<div class="track"><div class="fill"></div></div>';
    const fill = slider.querySelector('.fill');
    let dragging = false;
    const show = (v) => {
      const f = max > min ? (v - min) / (max - min) : 0;
      fill.style.width = Math.max(0, Math.min(1, f)) * 100 + '%';
      valueEl.textContent = format(v);
    };
    const sendThrottled = throttle(send, 200);
    makeSlider(slider, (f, final) => {
      api.poke();
      dragging = !final;
      const v = Math.max(min, Math.min(max, round(min + f * (max - min), step)));
      show(v);
      if (final) send(v); else sendThrottled(v);
    });
    api.onState(() => { if (!dragging) show(get()); });
    wrap.append(top, slider);
    return wrap;
  }

  function buttonRow(api, items) {
    const row = div('ha-buttons');
    for (const [label, fn, cls] of items) {
      const b = api.tap(button('ha-btn ' + (cls || ''), label), fn);
      if (/^mdi:/.test(label)) window.HA.setIcon(b, null, label);   // an icon instead of words
      row.appendChild(b);
    }
    return row;
  }

  function chips(api, label, options, current, pick) {
    const wrap = div('ha-control');
    wrap.appendChild(div('ha-control-label', label));
    const row = div('ha-chips');
    const els = options.map(([value, text]) => {
      const c = api.tap(button('ha-chip', text), () => pick(value));
      row.appendChild(c);
      return [value, c];
    });
    api.onState(() => { const cur = current(); for (const [v, c] of els) c.classList.toggle('on', v === cur); });
    wrap.appendChild(row);
    return wrap;
  }

  function stepper(api, ctx, id) {
    const box = div('ha-stepper');
    const nowEl = div('ha-now');
    const target = div('ha-target');
    const sp = setpoint(ctx, id, () => show());
    const show = () => {
      const a = (ctx.ha.states[id] || {}).attributes || {};
      nowEl.innerHTML = '';
      nowEl.append(div('ha-control-label', 'Now'), div('ha-now-value', fmtTemp(a.current_temperature)));
      target.textContent = fmtTemp(sp.pending != null ? sp.pending : a.temperature);
      target.classList.toggle('pending', sp.pending != null);
    };
    const minus = api.tap(button('ha-round', '−'), () => sp.bump(-1));
    const plus = api.tap(button('ha-round', '+'), () => sp.bump(1));
    const set = div('ha-set');
    set.append(div('ha-control-label', 'Target'), div('ha-set-row'));
    set.lastChild.append(minus, target, plus);
    box.append(nowEl, set);
    api.onState(show);
    return box;
  }

  // The controls for one entity, by type.
  function buildControls(api, ctx, id) {
    const st = () => ctx.ha.states[id] || { state: 'unavailable', attributes: {} };
    const a = () => st().attributes || {};
    const domain = domainOf(id);
    const call = (svc, data, dom = domain) => ctx.ha.callService(dom, svc, id, data).catch(fail(ctx));
    const b = api.body;
    const first = st().attributes || {};
    switch (domain) {
      case 'light': {
        b.appendChild(toggleBar(api, ctx, id));
        if (isDimmable(first)) {
          b.appendChild(bigSlider(api, {
            label: 'Brightness', min: 1, max: 100,
            get: () => (st().state === 'on' && a().brightness != null ? Math.round(a().brightness / 2.55) : 0),
            format: (v) => (v ? v + '%' : 'Off'), send: (v) => call('turn_on', { brightness_pct: v }),
          }));
        }
        if ((first.supported_color_modes || []).includes('color_temp')) {
          const lo = Number(first.min_color_temp_kelvin) || 2000, hi = Number(first.max_color_temp_kelvin) || 6500;
          b.appendChild(bigSlider(api, {
            label: 'Colour temperature', min: lo, max: hi, step: 50, cls: 'kelvin',
            get: () => Number(a().color_temp_kelvin) || lo,
            format: (v) => v + ' K', send: (v) => call('turn_on', { color_temp_kelvin: v }),
          }));
        }
        break;
      }
      case 'fan':
        b.appendChild(toggleBar(api, ctx, id));
        if (first.percentage != null || first.percentage_step != null) {
          b.appendChild(bigSlider(api, {
            label: 'Speed', min: 0, max: 100, step: Number(first.percentage_step) || 1,
            get: () => (st().state === 'on' ? Number(a().percentage) || 0 : 0),
            format: (v) => (v ? Math.round(v) + '%' : 'Off'), send: (v) => call('set_percentage', { percentage: Math.round(v) }),
          }));
        }
        break;
      case 'humidifier':
        b.appendChild(toggleBar(api, ctx, id));
        if (first.humidity != null) {
          b.appendChild(bigSlider(api, {
            label: 'Target humidity', min: Number(first.min_humidity) || 0, max: Number(first.max_humidity) || 100,
            get: () => Number(a().humidity) || 0, format: (v) => v + '%', send: (v) => call('set_humidity', { humidity: v }),
          }));
        }
        break;
      case 'climate': {
        b.appendChild(stepper(api, ctx, id));
        const modes = first.hvac_modes || [];
        if (modes.length) b.appendChild(chips(api, 'Mode', modes.map((m) => [m, m.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())]), () => st().state, (m) => call('set_hvac_mode', { hvac_mode: m })));
        break;
      }
      case 'water_heater': {
        b.appendChild(stepper(api, ctx, id));
        const ops = first.operation_list || [];
        if (ops.length) b.appendChild(chips(api, 'Mode', ops.map((m) => [m, m.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())]), () => a().operation_mode, (m) => call('set_operation_mode', { operation_mode: m })));
        break;
      }
      case 'cover':
        b.appendChild(buttonRow(api, [['Open', () => call('open_cover')], ['Stop', () => call('stop_cover')], ['Close', () => call('close_cover')]]));
        if (first.current_position != null) {
          b.appendChild(bigSlider(api, {
            label: 'Position', min: 0, max: 100, get: () => Number(a().current_position) || 0,
            format: (v) => (v === 0 ? 'Closed' : v === 100 ? 'Open' : v + '% open'), send: (v) => call('set_cover_position', { position: v }),
          }));
        }
        break;
      case 'valve':
        b.appendChild(buttonRow(api, [['Open', () => call('open_valve')], ['Close', () => call('close_valve')]]));
        break;
      case 'lock': {
        // The button for the state it's already in says so ("Locked ✓") and steps back.
        const items = [['Lock', () => call('lock'), 'primary'], ['Unlock', () => call('unlock'), 'warn']];
        if ((Number(first.supported_features) || 0) & 1) items.push(['Open the door', () => call('open'), 'warn']);
        const row = buttonRow(api, items);
        const [lockBtn, unlockBtn] = row.children;
        api.onState(() => {
          const locked = st().state === 'locked', unlocked = st().state === 'unlocked';
          lockBtn.textContent = locked ? 'Locked ✓' : 'Lock';
          unlockBtn.textContent = unlocked ? 'Unlocked ✓' : 'Unlock';
          lockBtn.classList.toggle('current', locked);
          unlockBtn.classList.toggle('current', unlocked);
        });
        b.appendChild(row);
        break;
      }
      case 'alarm_control_panel': {
        const feat = Number(first.supported_features) || 0;
        if (first.code_format) b.appendChild(div('ha-note', 'This alarm needs a code: use Home Assistant to disarm it.'));
        const items = [];
        if (!first.code_format) items.push(['Disarm', () => call('alarm_disarm'), 'warn']);
        if (!first.code_format || first.code_arm_required === false) {
          if (feat & 1) items.push(['Arm home', () => call('alarm_arm_home')]);
          if (feat & 2 || !feat) items.push(['Arm away', () => call('alarm_arm_away')]);
          if (feat & 4) items.push(['Arm night', () => call('alarm_arm_night')]);
        }
        if (items.length) b.appendChild(buttonRow(api, items));
        break;
      }
      case 'media_player': {
        const row = buttonRow(api, [['mdi:skip-previous', () => call('media_previous_track')], ['mdi:play-pause', () => call('media_play_pause'), 'primary'], ['mdi:skip-next', () => call('media_next_track')]]);
        if (first.is_volume_muted != null) {
          const mute = api.tap(button('ha-btn', ''), () => call('volume_mute', { is_volume_muted: !a().is_volume_muted }));
          api.onState(() => { mute.textContent = a().is_volume_muted ? 'Unmute' : 'Mute'; });
          row.appendChild(mute);
        }
        b.appendChild(row);
        if (first.volume_level != null) {
          b.appendChild(bigSlider(api, {
            label: 'Volume', min: 0, max: 100, get: () => Math.round((Number(a().volume_level) || 0) * 100),
            format: (v) => v + '%', send: (v) => call('volume_set', { volume_level: v / 100 }),
          }));
        }
        if ((first.source_list || []).length) b.appendChild(chips(api, 'Source', first.source_list.slice(0, 12).map((x) => [x, x]), () => a().source, (x) => call('select_source', { source: x })));
        break;
      }
      case 'scene': case 'script': case 'button': case 'input_button': {
        const label = { scene: 'Activate', script: 'Run', button: 'Press', input_button: 'Press' }[domain];
        const svc = domain === 'scene' || domain === 'script' ? 'turn_on' : 'press';
        b.appendChild(api.tap(button('ha-bar', label), () => call(svc).then(() => ctx.toast(label === 'Activate' ? 'Activated' : 'Done'))));
        break;
      }
      case 'input_number': case 'number':
        b.appendChild(bigSlider(api, {
          label: 'Value', min: Number(first.min) || 0, max: Number(first.max) || 100, step: Number(first.step) || 1,
          get: () => Number(st().state) || 0, format: (v) => v + (first.unit_of_measurement ? ' ' + first.unit_of_measurement : ''),
          send: (v) => call('set_value', { value: v }),
        }));
        break;
      case 'input_select': case 'select':
        b.appendChild(chips(api, 'Option', (first.options || []).map((o) => [o, o]), () => st().state, (o) => call('select_option', { option: o })));
        break;
      case 'switch': case 'input_boolean': case 'automation': case 'siren': case 'remote':
        b.appendChild(toggleBar(api, ctx, id));
        break;
      default: {
        // Sensors and anything else: the value, big.
        const big = div('ha-big-value');
        api.onState(() => { big.textContent = ctx.ha.describe(st()) || st().state; });
        b.appendChild(big);
      }
    }
  }

  function openEntitySheet(ctx, id) {
    return sheet(ctx, {
      watch: [id],
      title: () => ctx.ha.name(id),
      sub: () => {
        const st = ctx.ha.states[id];
        if (!st) return ctx.ha.status === 'connected' ? 'Not found in Home Assistant' : 'Home Assistant ' + ctx.ha.status;
        const area = ctx.ha.areaName(ctx.ha.areaOf(id));
        const when = ctx.ha.ago(st.last_changed);
        return [ctx.ha.describe(st), area, when && 'changed ' + (when === 'just now' ? when : when + ' ago')].filter(Boolean).join(' · ');
      },
      icon: (el) => {
        ctx.ha.setIcon(el, id);
        const st = ctx.ha.states[id];
        el.classList.toggle('on', !!st && ctx.ha.ON_STATES.has(st.state));
      },
      build: (api) => buildControls(api, ctx, id),
    });
  }

  // A list of entities (an area's lights and switches): tap a row to toggle it,
  // drag its slider to dim, hold it for all its controls.
  function openListSheet(ctx, { title, ids, icon }) {
    const lights = () => ids.filter((id) => domainOf(id) === 'light');
    return sheet(ctx, {
      watch: ids,
      wide: true,
      title: () => title,
      sub: () => {
        const l = lights();
        const on = l.filter((id) => (ctx.ha.states[id] || {}).state === 'on').length;
        return l.length ? `${on} of ${l.length} light${l.length === 1 ? '' : 's'} on` : `${ids.length} controls`;
      },
      icon: (el) => ctx.ha.setIcon(el, null, icon || 'mdi:sofa'),
      build: (api) => {
        if (lights().length > 1) {
          api.body.appendChild(buttonRow(api, [
            ['All lights on', () => ctx.ha.callService('light', 'turn_on', lights()).catch(fail(ctx))],
            ['All lights off', () => ctx.ha.callService('light', 'turn_off', lights()).catch(fail(ctx))],
          ]));
        }
        const list = div('ha-list');
        list._edgeScroll = true;
        for (const id of ids) {
          const row = div('ha-list-row pressable');
          const ic = div('ha-icon');
          const text = div('ha-text');
          const name = div('ha-name');
          const state = div('ha-state');
          text.append(name, state);
          row.append(ic, text);
          const st0 = ctx.ha.states[id];
          let slider = null, dragging = false;
          if (domainOf(id) === 'light' && st0 && isDimmable(st0.attributes)) {
            slider = div('ha-row-slider slider');
            slider.innerHTML = '<div class="track"><div class="fill"></div><div class="knob"></div></div>';
            const send = throttle((pct) => ctx.ha.callService('light', 'turn_on', id, { brightness_pct: pct }).catch(() => {}), 200);
            makeSlider(slider, (f, final) => {
              api.poke();
              dragging = !final;
              const pct = Math.max(1, Math.round(f * 100));
              slider.querySelector('.fill').style.width = pct + '%';
              slider.querySelector('.knob').style.left = pct + '%';
              state.textContent = pct + '%';
              send(pct);
            });
            row.appendChild(slider);
          }
          api.tap(row, () => {
            const st = ctx.ha.states[id];
            const svc = st && ctx.ha.tapService(st);
            if (svc) ctx.ha.callService(svc[0], svc[1], id).catch(fail(ctx));
          });
          row._edgeLong = () => openEntitySheet(ctx, id);
          api.onState(() => {
            const st = ctx.ha.states[id];
            const on = !!st && ctx.ha.ON_STATES.has(st.state);
            name.textContent = ctx.ha.name(id);
            if (!dragging) state.textContent = ctx.ha.describe(st) || 'Not found';
            ctx.ha.setIcon(ic, id);
            row.classList.toggle('on', on);
            row.classList.toggle('unavailable', !st || st.state === 'unavailable');
            if (slider && !dragging) {
              const pct = on && st.attributes.brightness != null ? Math.round(st.attributes.brightness / 2.55) : 0;
              slider.querySelector('.fill').style.width = pct + '%';
              slider.querySelector('.knob').style.left = pct + '%';
            }
          });
          list.appendChild(row);
        }
        api.body.appendChild(list);
      },
    });
  }

  // Why a widget has nothing to show, or '' if it's fine.
  function problem(ctx, has, what) {
    if (!has) return ctx.edit ? `Choose ${what}` : 'Not set up';
    if (ctx.ha.status !== 'connected') return ctx.ha.status === 'not configured' ? 'Home Assistant not set up' : 'Home Assistant ' + ctx.ha.status;
    return '';
  }

  // ---------------- Entity tile ----------------
  const haEntity = {
    name: 'Home Assistant entity',
    size: [3, 1],
    props: [
      { key: 'entity', label: 'Entity', type: 'entity' },
      { key: 'name', label: 'Name (optional)', type: 'text' },
      { key: 'icon', label: 'Icon (optional)', type: 'text', placeholder: '💡 or mdi:lightbulb', hint: 'An emoji, or a Material Design icon name as in Home Assistant. Leave empty to use Home Assistant’s.' },
      { key: 'showSlider', label: 'Brightness slider for lights', type: 'bool', default: true },
      { key: 'confirmLock', label: 'Unlock only from the hold controls', type: 'bool', default: true, hint: 'Tapping a locked lock does nothing; hold it, then tap Unlock.' },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.classList.add('pressable');
      el.innerHTML = `
        <div class="ha-top"><div class="ha-icon"></div><div class="ha-text"><div class="ha-name"></div><div class="ha-state"></div></div></div>
        <div class="ha-slider slider"><div class="track"><div class="fill"></div><div class="knob"></div></div></div>`;
      const $ = (q) => el.querySelector(q);
      const slider = $('.ha-slider');
      const domain = domainOf(s.entity);
      let dragging = false;
      let pending = null;

      const setBrightness = throttle((pct) => ctx.ha.callService('light', 'turn_on', s.entity, { brightness_pct: pct }).catch(() => {}), 150);
      makeSlider(slider, (f, final) => {
        dragging = !final;
        pending = Math.max(1, Math.round(f * 100));
        slider.querySelector('.fill').style.width = pending + '%';
        slider.querySelector('.knob').style.left = pending + '%';
        $('.ha-state').textContent = pending + '%';
        setBrightness(pending);
      });

      // Climate on a wide tile: − / + for the target temperature.
      let sp = null;
      if ((domain === 'climate' || domain === 'water_heater') && s.w >= 4) {
        sp = setpoint(ctx, s.entity, () => render(s.entity));
        const steps = div('ha-steps');
        steps.append(button('ha-step', '−', () => sp.bump(-1)), button('ha-step', '+', () => sp.bump(1)));
        el.appendChild(steps);
        el.classList.add('has-steps');
      }

      el._edgeTap = () => {
        const st = ctx.ha.states[s.entity];
        if (!st) return;
        if (domain === 'lock' && st.state === 'locked' && s.confirmLock !== false) {
          ctx.toast('Hold to unlock');
          return;
        }
        const svc = ctx.ha.tapService(st);
        if (!svc) return openEntitySheet(ctx, s.entity);   // sensors and the like: show the details
        ctx.ha.callService(svc[0], svc[1], s.entity).catch(fail(ctx));
      };
      el._edgeLong = () => { if (s.entity && !ctx.edit) openEntitySheet(ctx, s.entity); };

      function render(id) {
        if (id !== '*' && id !== s.entity) return;
        const st = ctx.ha.states[s.entity];
        const a = (st && st.attributes) || {};
        const status = problem(ctx, !!s.entity, 'an entity') || (!st ? 'Not found' : '');
        $('.ha-name').textContent = s.name || (st ? a.friendly_name : '') || ctx.ha.name(s.entity) || 'Home Assistant';
        let text = status || ctx.ha.describe(st);
        if (!status && sp && sp.pending != null) text = (a.current_temperature != null ? fmtTemp(a.current_temperature) + ' → ' : '→ ') + fmtTemp(sp.pending);
        $('.ha-state').textContent = text;
        ctx.ha.setIcon($('.ha-icon'), s.entity, s.icon);
        const on = !!st && ctx.ha.ON_STATES.has(st.state);
        el.classList.toggle('on', on);
        el.classList.toggle('unavailable', !st || st.state === 'unavailable');
        const dimmable = domain === 'light' && s.showSlider !== false && s.w >= 2 && isDimmable(a) && st.state !== 'unavailable';
        slider.style.display = dimmable ? '' : 'none';
        el.classList.toggle('has-slider', dimmable);
        if (dimmable && !dragging) {
          const pct = st.state === 'on' && a.brightness != null ? Math.round(a.brightness / 2.55) : 0;
          slider.querySelector('.fill').style.width = pct + '%';
          slider.querySelector('.knob').style.left = pct + '%';
        }
      }
      const unsub = ctx.ha.subscribe(render);
      render('*');
      // Keeps "Unavailable · 2 h" and "Last used 5 min ago" current.
      const tick = setInterval(() => render('*'), 60000);
      return { destroy() { unsub(); clearInterval(tick); } };
    },
  };

  // ---------------- Camera ----------------
  const haCamera = {
    name: 'Home Assistant camera',
    size: [4, 2],
    props: [
      { key: 'entity', label: 'Camera', type: 'entity', domains: ['camera'] },
      { key: 'name', label: 'Name (optional)', type: 'text' },
      { key: 'refresh', label: 'Refresh every (seconds)', type: 'number', default: 5, min: 1, max: 600 },
    ],
    create(el, s, ctx) {
      el.classList.add('pressable');
      el.innerHTML = '<img class="cam-img" alt=""><div class="cam-msg"></div><div class="cam-name"></div>';
      const img = el.querySelector('.cam-img');
      const msg = el.querySelector('.cam-msg');
      const nameEl = el.querySelector('.cam-name');
      let loading = false;

      function refresh() {
        const st = ctx.ha.states[s.entity];
        nameEl.textContent = s.name || (st && st.attributes.friendly_name) || s.entity || 'Camera';
        const why = problem(ctx, !!s.entity, 'a camera');
        if (why) { msg.textContent = why; return; }
        if (!st) { msg.textContent = 'Not found'; return; }
        const pic = st.attributes.entity_picture;
        if (!pic) { msg.textContent = ctx.ha.mock ? 'Camera preview' : 'No image'; return; }
        if (loading) return;
        loading = true;
        const next = new Image();
        next.onload = () => { img.src = next.src; msg.textContent = ''; loading = false; };
        next.onerror = () => { msg.textContent = 'Image failed to load'; loading = false; };
        next.src = ctx.ha.imageUrl(pic) + (pic.includes('?') ? '&' : '?') + '_=' + Date.now();
      }

      el._edgeTap = () => {
        if (!img.src) return;
        const overlay = document.createElement('div');
        overlay.className = 'cam-overlay';
        const big = document.createElement('img');
        big.src = img.src;
        overlay.appendChild(big);
        overlay._edgeTap = () => overlay.remove();
        document.body.appendChild(overlay);
        const t = setInterval(() => {
          if (!overlay.isConnected) return clearInterval(t);
          big.src = img.src;
        }, 1000);
      };

      const unsub = ctx.ha.subscribe((id) => { if (id === '*' || id === s.entity) refresh(); });
      refresh();
      const timer = setInterval(refresh, Math.max(1, Number(s.refresh) || 5) * 1000);
      return { destroy() { clearInterval(timer); unsub(); } };
    },
  };

  // ---------------- Sensor glance ----------------
  // A few values side by side: big number, small unit, name underneath.
  function splitValue(ctx, st) {
    if (!st) return ['–', ''];
    const a = st.attributes || {};
    if (st.state === 'unavailable' || st.state === 'unknown') return ['–', ''];
    const n = Number(st.state);
    if (a.unit_of_measurement && !isNaN(n)) {
      const u = a.unit_of_measurement;
      const v = String(Math.round(n * 10) / 10);
      return u === '°C' || u === '°F' ? [v + '°', ''] : [v, u];
    }
    return [ctx.ha.describe(st), ''];
  }

  const haGlance = {
    name: 'Home Assistant sensors',
    size: [6, 1],
    props: [
      { key: 'entities', label: 'Sensors', type: 'entities', types: ['sensor'] },
      { key: 'title', label: 'Title (optional)', type: 'text' },
      { key: 'showNames', label: 'Show names', type: 'bool', default: true },
      { key: 'showIcons', label: 'Show icons', type: 'bool', default: false },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      const ids = Array.isArray(s.entities) ? s.entities : [];
      el.classList.toggle('titled', !!s.title);
      if (s.title) el.appendChild(div('gl-title', s.title));
      const row = div('gl-row');
      el.appendChild(row);
      const msg = div('gl-msg');
      el.appendChild(msg);
      const cells = ids.map((id) => {
        const cell = div('gl-cell pressable');
        const top = div('gl-top');
        const icon = div('gl-icon');
        const value = div('gl-value');
        const unit = document.createElement('span');
        unit.className = 'gl-unit';
        const num = document.createElement('span');
        value.append(num, unit);
        if (s.showIcons) top.appendChild(icon);
        top.appendChild(value);
        const name = div('gl-name');
        cell.append(top);
        if (s.showNames !== false) cell.appendChild(name);
        cell._edgeTap = () => openEntitySheet(ctx, id);
        row.appendChild(cell);
        return { id, cell, icon, num, unit, name };
      });
      function render(id) {
        if (id !== '*' && !ids.includes(id)) return;
        const why = problem(ctx, ids.length, 'some sensors');
        msg.textContent = why;
        row.style.display = why ? 'none' : '';
        for (const c of cells) {
          if (id !== '*' && id !== c.id) continue;
          const st = ctx.ha.states[c.id];
          const [v, u] = splitValue(ctx, st);
          c.num.textContent = v;
          c.unit.textContent = u;
          c.name.textContent = ctx.ha.name(c.id);
          if (s.showIcons) ctx.ha.setIcon(c.icon, c.id);
          c.cell.classList.toggle('on', !!st && domainOf(c.id) === 'binary_sensor' && st.state === 'on');
          c.cell.classList.toggle('unavailable', !st || st.state === 'unavailable');
        }
      }
      const unsub = ctx.ha.subscribe(render);
      render('*');
      return { destroy: unsub };
    },
  };

  // ---------------- Scene strip ----------------
  const RUN = { scene: ['scene', 'turn_on'], script: ['script', 'turn_on'], button: ['button', 'press'], input_button: ['input_button', 'press'], automation: ['automation', 'trigger'] };
  const haScenes = {
    name: 'Home Assistant scenes',
    size: [6, 1],
    props: [
      { key: 'entities', label: 'Scenes, scripts and buttons', type: 'entities', types: ['scene'], domains: ['scene', 'script', 'button', 'input_button', 'automation'] },
      { key: 'showIcons', label: 'Show icons', type: 'bool', default: true },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      const ids = Array.isArray(s.entities) ? s.entities : [];
      const box = div('sc-row');
      el.appendChild(box);
      const msg = div('gl-msg');
      el.appendChild(msg);
      // Two rows or more: wrap into a grid.
      const perRow = s.h >= 2 ? Math.ceil(ids.length / Math.min(s.h, Math.ceil(ids.length / 2))) : ids.length;
      box.style.gridTemplateColumns = `repeat(${Math.max(1, perRow)}, minmax(0, 1fr))`;
      const btns = ids.map((id) => {
        const b = div('sc-btn pressable');
        const icon = div('sc-icon');
        const name = div('sc-name');
        if (s.showIcons !== false) b.appendChild(icon);
        b.appendChild(name);
        b._edgeTap = () => {
          const run = RUN[domainOf(id)];
          if (!run) return;
          ctx.ha.callService(run[0], run[1], id).then(() => {
            b.classList.add('done');
            setTimeout(() => b.classList.remove('done'), 1200);
          }).catch(fail(ctx));
        };
        box.appendChild(b);
        return { id, icon, name };
      });
      function render(id) {
        if (id !== '*' && !ids.includes(id)) return;
        const why = problem(ctx, ids.length, 'some scenes');
        msg.textContent = why;
        box.style.display = why ? 'none' : '';
        for (const b of btns) {
          b.name.textContent = ctx.ha.name(b.id);
          if (s.showIcons !== false) ctx.ha.setIcon(b.icon, b.id);
        }
      }
      const unsub = ctx.ha.subscribe(render);
      render('*');
      return { destroy: unsub };
    },
  };

  // ---------------- Area ----------------
  // A room at a glance: a lamp per light (lit or grey), its temperature and humidity.
  // Tap: all its lights off (or on, if none are). Hold: each light and switch.
  const AREA_CONTROLS = ['light', 'switch', 'fan', 'cover', 'input_boolean', 'media_player', 'climate', 'lock'];
  const haArea = {
    name: 'Home Assistant area',
    size: [4, 1],
    props: [
      { key: 'area', label: 'Area', type: 'haarea' },
      { key: 'name', label: 'Name (optional)', type: 'text' },
      { key: 'icon', label: 'Icon (optional)', type: 'text', placeholder: 'mdi:sofa' },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.classList.add('pressable');
      const head = div('ar-head');
      const icon = div('ar-icon');
      const name = div('ar-name');
      const lamps = div('ar-lamps');
      head.append(icon, name, lamps);
      const climate = div('ar-climate');
      el.append(head, climate);
      const lights = () => ctx.ha.areaEntities(s.area, ['light']);
      el._edgeTap = () => {
        const l = lights();
        if (!l.length) return;
        const anyOn = l.some((id) => (ctx.ha.states[id] || {}).state === 'on');
        ctx.ha.callService('light', anyOn ? 'turn_off' : 'turn_on', l).catch(fail(ctx));
      };
      el._edgeLong = () => {
        if (ctx.edit || !s.area) return;
        const ids = ctx.ha.areaEntities(s.area, AREA_CONTROLS)
          .sort((x, y) => AREA_CONTROLS.indexOf(domainOf(x)) - AREA_CONTROLS.indexOf(domainOf(y)) || ctx.ha.name(x).localeCompare(ctx.ha.name(y)));
        if (!ids.length) return ctx.toast('Nothing to control in this area');
        openListSheet(ctx, { title: s.name || ctx.ha.areaName(s.area) || 'Area', ids, icon: s.icon });
      };
      let watched = new Set();
      function render(id) {
        if (id !== '*' && !watched.has(id)) return;
        const why = problem(ctx, !!s.area, 'an area') ||
          (!ctx.ha.hasRegistry ? 'Areas aren’t available' : !ctx.ha.areas.has(s.area) ? 'Area not found' : '');
        name.textContent = s.name || ctx.ha.areaName(s.area) || 'Area';
        ctx.ha.setIcon(icon, null, s.icon || 'mdi:sofa');
        const all = s.area ? ctx.ha.areaEntities(s.area) : [];
        watched = new Set(all);
        const l = all.filter((x) => domainOf(x) === 'light');
        lamps.replaceChildren(...l.slice(0, 8).map((x) => {
          const st = ctx.ha.states[x];
          const lamp = div('ar-lamp mdi' + (st && st.state === 'on' ? ' on' : ''));
          lamp.textContent = String.fromCodePoint(window.MDI_ICONS.get(st && st.state === 'on' ? 'lightbulb-on' : 'lightbulb-outline') || 0x25cf);
          return lamp;
        }));
        el.classList.toggle('on', l.some((x) => (ctx.ha.states[x] || {}).state === 'on'));
        const find = (cls) => all.find((x) => domainOf(x) === 'sensor' && ((ctx.ha.states[x] || {}).attributes || {}).device_class === cls);
        const t = find('temperature'), hm = find('humidity');
        const parts = [];
        if (t) parts.push(fmtTemp(Number(ctx.ha.states[t].state)));
        if (hm) parts.push(Math.round(Number(ctx.ha.states[hm].state)) + '%');
        climate.textContent = why || parts.join('   ') || (l.length ? `${l.filter((x) => (ctx.ha.states[x] || {}).state === 'on').length} of ${l.length} lights on` : '');
        climate.classList.toggle('muted', !!why || !parts.length);
      }
      const unsub = ctx.ha.subscribe(render);
      render('*');
      return { destroy: unsub };
    },
  };

  Object.assign(window.Widgets, { 'ha-entity': haEntity, 'ha-glance': haGlance, 'ha-scenes': haScenes, 'ha-area': haArea, 'ha-camera': haCamera });
  window.HASheet = { open: openEntitySheet, list: openListSheet };
})();
