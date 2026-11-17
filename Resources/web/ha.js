// Home Assistant client over the WebSocket API (no CORS set-up needed), plus the
// shared knowledge about entities (types, icons, how to describe a state, what a
// tap does) used by the widgets, the editor's entity picker, Settings and Setup.
(function () {
  // ---------- Entity types (the picker's filter chips) ----------
  // [key, label, domains]. Anything not listed is "other".
  const TYPES = [
    ['light', 'Lights', ['light']],
    ['switch', 'Switches & fans', ['switch', 'input_boolean', 'fan', 'siren', 'remote']],
    ['sensor', 'Sensors', ['sensor', 'binary_sensor']],
    ['climate', 'Climate', ['climate', 'water_heater', 'humidifier']],
    ['cover', 'Covers', ['cover', 'valve']],
    ['lock', 'Locks & alarms', ['lock', 'alarm_control_panel']],
    ['media', 'Media', ['media_player']],
    ['scene', 'Scenes & scripts', ['scene', 'script', 'automation', 'button', 'input_button']],
    ['camera', 'Cameras', ['camera']],
    ['other', 'Other', []],
  ];
  const TYPE_OF_DOMAIN = {};
  for (const [key, , domains] of TYPES) for (const d of domains) TYPE_OF_DOMAIN[d] = key;
  const domainOf = (id) => String(id || '').split('.')[0];
  const typeOf = (idOrDomain) => TYPE_OF_DOMAIN[domainOf(idOrDomain)] || 'other';

  // ---------- Icons ----------
  const DOMAIN_ICON = {
    light: '💡', switch: '⏻', fan: '🌀', climate: '🌡️', lock: '🔒', cover: '🪟', sensor: '📈',
    binary_sensor: '◉', media_player: '🔈', scene: '🎬', script: '📜', automation: '🤖',
    input_boolean: '⏻', button: '🔘', input_button: '🔘', camera: '📷', person: '👤', vacuum: '🧹', water_heater: '♨️',
    humidifier: '💧', valve: '🚰', alarm_control_panel: '🛡️', update: '⬆️', sun: '☀️', weather: '🌤️',
    device_tracker: '📍', zone: '📍', number: '🔢', input_number: '🔢', select: '☰', input_select: '☰',
    remote: '📡', siren: '🚨', input_text: '✎', text: '✎', calendar: '📅', todo: '☑︎',
  };
  const CLASS_ICON = {
    temperature: '🌡️', humidity: '💧', battery: '🔋', power: '⚡️', energy: '⚡️', voltage: '⚡️', current: '⚡️',
    door: '🚪', opening: '🚪', window: '🪟', garage_door: '🚗', garage: '🚗', motion: '🏃', occupancy: '🏃', presence: '🏠',
    illuminance: '☀️', moisture: '💧', smoke: '🔥', gas: '🔥', plug: '🔌', outlet: '🔌', connectivity: '📶',
    carbon_dioxide: '🫧', pressure: '⏲️', pm25: '🌫️', speaker: '🔈', tv: '📺', blind: '🪟', shade: '🪟', curtain: '🪟',
  };

  // Turns "mdi:lightbulb" into a code point in the bundled Material Design Icons font.
  function mdi(name) {
    const m = /^mdi:([a-z0-9-]+)$/.exec(String(name || '').trim());
    return m && window.MDI_ICONS ? window.MDI_ICONS.get(m[1]) || null : null;
  }

  // ---------- Describing states ----------
  // binary_sensor on/off in words, by device class (as Home Assistant shows them).
  const BINARY_WORDS = {
    door: ['Open', 'Closed'], window: ['Open', 'Closed'], garage_door: ['Open', 'Closed'], opening: ['Open', 'Closed'],
    motion: ['Detected', 'Clear'], occupancy: ['Detected', 'Clear'], presence: ['Home', 'Away'],
    moisture: ['Wet', 'Dry'], smoke: ['Detected', 'Clear'], gas: ['Detected', 'Clear'], carbon_monoxide: ['Detected', 'Clear'],
    connectivity: ['Connected', 'Disconnected'], plug: ['Plugged in', 'Unplugged'], battery: ['Low', 'Normal'],
    lock: ['Unlocked', 'Locked'], problem: ['Problem', 'OK'], safety: ['Unsafe', 'Safe'], running: ['Running', 'Not running'],
  };
  const ON_STATES = new Set(['on', 'open', 'opening', 'unlocked', 'unlocking', 'playing', 'home', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only', 'active', 'cleaning']);

  // "3 min", "2 h", "4 days"
  function ago(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    const d = Math.round(s / 86400);
    return d + (d === 1 ? ' day' : ' days');
  }

  const cap = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const num = (v) => { const n = Number(v); return isNaN(n) ? v : Math.round(n * 10) / 10; };

  function describe(st) {
    if (!st) return '';
    const a = st.attributes || {};
    const domain = domainOf(st.entity_id);
    if (st.state === 'unavailable') {
      const since = ago(st.last_changed);
      return 'Unavailable' + (since && since !== 'just now' ? ' · ' + since : '');
    }
    if (st.state === 'unknown') return 'Unknown';
    if (domain === 'climate') {
      const cur = a.current_temperature != null ? num(a.current_temperature) + '°' : '';
      const set = a.temperature != null ? ' → ' + num(a.temperature) + '°' : '';
      return (cur + set) || cap(st.state) + (st.state === 'off' && (cur || set) ? ' · off' : '');
    }
    if (domain === 'light' && st.state === 'on' && a.brightness != null) return Math.round(a.brightness / 2.55) + '%';
    if (domain === 'cover' && a.current_position != null && st.state === 'open') return 'Open · ' + a.current_position + '%';
    if (domain === 'fan' && st.state === 'on' && a.percentage != null) return a.percentage + '%';
    if (domain === 'media_player' && a.media_title && (st.state === 'playing' || st.state === 'paused')) return a.media_title;
    if (domain === 'binary_sensor') {
      const w = BINARY_WORDS[a.device_class];
      if (w && (st.state === 'on' || st.state === 'off')) return st.state === 'on' ? w[0] : w[1];
    }
    if (a.device_class === 'timestamp') {
      const t = Date.parse(st.state);
      if (t) return new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }
    if (domain === 'scene' || domain === 'button' || domain === 'input_button') {
      const when = ago(st.state);
      return when ? 'Last used ' + (when === 'just now' ? when : when + ' ago') : '';
    }
    if (a.unit_of_measurement) {
      const n = num(st.state);
      return n + (a.unit_of_measurement === '%' ? '%' : ' ' + a.unit_of_measurement);
    }
    return cap(st.state);
  }

  // What a quick tap does: [domain, service], or null (show the controls instead).
  function tapService(st) {
    const domain = domainOf(st.entity_id);
    switch (domain) {
      case 'light': case 'switch': case 'fan': case 'input_boolean': case 'automation': case 'cover': case 'climate':
      case 'valve': case 'humidifier': case 'siren': case 'remote':
        return [domain, 'toggle'];
      case 'media_player': return [domain, 'media_play_pause'];
      case 'lock': return [domain, st.state === 'locked' ? 'unlock' : 'lock'];
      case 'scene': case 'script': return [domain, 'turn_on'];
      case 'button': case 'input_button': return [domain, 'press'];
      default: return null;
    }
  }

  // ---------- Client ----------
  class HAClient {
    constructor() {
      this.url = '';
      this.token = '';
      this.ws = null;
      this.status = 'not configured';
      this.states = {};
      this.areas = new Map();      // area_id -> { id, name }
      this.devices = new Map();    // device_id -> { area }
      this.registry = new Map();   // entity_id -> { area, device, hidden, category, name, icon }
      this.hasRegistry = false;
      this.info = {};              // { name, version }
      this.everConnected = false;
      this.listeners = new Set();
      this.pending = new Map();
      this.nextId = 1;
      this.retry = 1000;
      this.retryTimer = null;
      this.mock = false;
      this.servicesPromise = null;
      this.TYPES = TYPES;
    }

    // Accepts "homeassistant.local:8123" or a pasted dashboard link; keeps scheme, host and port.
    static normalise(url) {
      url = (url || '').trim();
      if (!url || url === 'mock') return url;
      if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return null;
        return u.origin;
      } catch (e) { return null; }
    }

    configure(url, token) {
      const norm = HAClient.normalise(url);
      token = (token || '').trim();
      // Same settings: leave it be (a dropped connection retries by itself; a rejected
      // token stays rejected until it changes or Settings' Test button is used).
      if (norm === this.url && token === this.token &&
          (this.ws || this.mock || this.retryTimer || ['bad URL', 'not configured', 'auth failed'].includes(this.status))) return;
      this.close();
      this.url = norm || '';
      this.token = token;
      this.retry = 1000;
      this.everConnected = false;
      if (norm === null) return this.setStatus('bad URL');
      if (norm === 'mock') return this.startMock();
      if (!norm || !token) return this.setStatus('not configured');
      this.connect();
    }

    // Settings' "Test connection": start again from scratch.
    reconnect(url = this.url, token = this.token) {
      this.url = null;
      this.configure(url, token);
    }

    close() {
      clearTimeout(this.retryTimer);
      clearTimeout(this.connectTimer);
      this.retryTimer = null;
      if (this.ws) {
        this.ws.onclose = null;
        try { this.ws.close(); } catch (e) {}
      }
      for (const p of this.pending.values()) p.reject(new Error('Home Assistant disconnected'));
      this.pending.clear();
      this.ws = null;
      this.mock = false;
      this.status = 'not configured';   // configure() sets the real one straight after
      this.states = {};
      this.areas = new Map();
      this.devices = new Map();
      this.registry = new Map();
      this.hasRegistry = false;
      this.info = {};
      this.servicesPromise = null;
    }

    setStatus(s) {
      this.status = s;
      this.emit('*');
    }

    connect() {
      let wsUrl;
      try {
        wsUrl = this.url.replace(/^http/i, 'ws') + '/api/websocket';
        this.ws = new WebSocket(wsUrl);
      } catch (e) {
        this.setStatus('bad URL');
        return;
      }
      // Retrying after a failure stays "offline", so the reason stays on screen.
      if (this.status !== 'offline') this.setStatus('connecting');
      // A name that never resolves can leave the socket "connecting" for minutes: give up
      // after 10 s (onclose then reports it offline and retries).
      const ws = this.ws;
      clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => { if (ws.readyState === 0) ws.close(); }, 10000);
      this.ws.onopen = () => clearTimeout(this.connectTimer);
      this.ws.onmessage = (e) => this.handle(JSON.parse(e.data));
      this.ws.onclose = () => {
        clearTimeout(this.connectTimer);
        this.ws = null;
        for (const p of this.pending.values()) p.reject(new Error('Home Assistant disconnected'));
        this.pending.clear();
        this.servicesPromise = null;
        if (this.status === 'auth failed') return;
        this.setStatus('offline');
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, this.retry);
        this.retry = Math.min(this.retry * 2, 30000);
      };
    }

    send(msg) {
      if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Home Assistant not connected'));
      const id = this.nextId++;
      msg.id = id;
      this.ws.send(JSON.stringify(msg));
      return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    handle(m) {
      switch (m.type) {
        case 'auth_required':
          this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
          break;
        case 'auth_invalid':
          this.setStatus('auth failed');
          this.ws.close();
          break;
        case 'auth_ok':
          this.retry = 1000;
          this.everConnected = true;
          this.info = { version: m.ha_version };
          this.setStatus('connected');
          this.loadAll();
          this.send({ type: 'subscribe_events', event_type: 'state_changed' });
          // Areas or entity settings changed in Home Assistant: reload the registry.
          for (const ev of ['area_registry_updated', 'entity_registry_updated', 'device_registry_updated']) {
            this.send({ type: 'subscribe_events', event_type: ev }).catch(() => {});
          }
          break;
        case 'result': {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            m.success ? p.resolve(m.result) : p.reject(new Error((m.error && m.error.message) || 'Failed'));
          }
          break;
        }
        case 'event': {
          const ev = m.event || {};
          if (/_registry_updated$/.test(ev.event_type || '')) {
            clearTimeout(this.registryTimer);
            this.registryTimer = setTimeout(() => this.loadRegistry().then(() => this.emit('*')), 1000);
            break;
          }
          const d = ev.data;
          if (d && d.entity_id) {
            if (d.new_state) this.states[d.entity_id] = d.new_state;
            else delete this.states[d.entity_id];
            this.emit(d.entity_id);
          }
          break;
        }
      }
    }

    // States, the server's name, and the registries (areas, devices, entity settings).
    // The registries are what the Home Assistant frontend uses; if they can't be read
    // (e.g. an older or restricted server), everything still works without areas.
    async loadAll() {
      const states = this.send({ type: 'get_states' }).catch(() => []);
      const config = this.send({ type: 'get_config' }).catch(() => null);
      const [st, cfg] = await Promise.all([states, config, this.loadRegistry()]);
      this.states = {};
      for (const s of st || []) this.states[s.entity_id] = s;
      if (cfg) this.info = { name: cfg.location_name, version: cfg.version || this.info.version };
      this.emit('*');
    }

    async loadRegistry() {
      const [areas, devices, ents] = await Promise.all([
        this.send({ type: 'config/area_registry/list' }).catch(() => null),
        this.send({ type: 'config/device_registry/list' }).catch(() => null),
        this.send({ type: 'config/entity_registry/list_for_display' }).catch(() => null),
      ]);
      this.applyRegistry(areas, devices, ents);
    }

    applyRegistry(areas, devices, ents) {
      this.areas = new Map((areas || []).map((a) => [a.area_id, { id: a.area_id, name: a.name }]));
      this.devices = new Map((devices || []).map((d) => [d.id, { area: d.area_id || null }]));
      this.registry = new Map();
      const cats = (ents && ents.entity_categories) || {};
      for (const e of (ents && ents.entities) || []) {
        this.registry.set(e.ei, {
          area: e.ai || null, device: e.di || null, hidden: !!e.hb,
          category: e.ec != null ? cats[e.ec] || 'config' : null, name: e.en || null, icon: e.ic || null,
        });
      }
      this.hasRegistry = !!ents;
    }

    emit(entityId) {
      for (const fn of this.listeners) {
        try { fn(entityId); } catch (e) { console.error(e); }
      }
    }

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    // target: an entity id or a list of them.
    callService(domain, service, target, data = {}) {
      if (this.mock) return this.mockService(domain, service, target, data);
      const msg = { type: 'call_service', domain, service, service_data: data };
      if (target && (!Array.isArray(target) || target.length)) msg.target = { entity_id: target };
      return this.send(msg);
    }

    // Every service, with names and fields: { domain: { service: { name, fields } } }.
    services() {
      if (this.mock) return Promise.resolve(MOCK_SERVICES);
      if (!this.servicesPromise) {
        this.servicesPromise = this.send({ type: 'get_services' }).catch((e) => { this.servicesPromise = null; throw e; });
      }
      return this.servicesPromise;
    }

    imageUrl(path) {
      if (!path) return '';
      if (/^https?:|^data:/.test(path)) return path;
      return this.url + path;
    }

    // ---------- Entity helpers ----------
    name(id) {
      const st = this.states[id];
      const reg = this.registry.get(id);
      return (st && st.attributes.friendly_name) || (reg && reg.name) || id;
    }
    areaOf(id) {
      const reg = this.registry.get(id);
      if (!reg) return null;
      return reg.area || (reg.device && this.devices.get(reg.device) ? this.devices.get(reg.device).area : null);
    }
    areaName(areaId) {
      const a = this.areas.get(areaId);
      return a ? a.name : '';
    }
    // Hidden in Home Assistant, or a settings/diagnostic entity (firmware, signal strength…).
    isClutter(id) {
      const reg = this.registry.get(id);
      return !!reg && (reg.hidden || !!reg.category);
    }
    // Every entity, ready for the picker.
    entityList() {
      return Object.keys(this.states).map((id) => {
        const areaId = this.areaOf(id);
        return { id, domain: domainOf(id), type: typeOf(id), name: this.name(id), areaId, area: this.areaName(areaId), clutter: this.isClutter(id) };
      });
    }
    // An area's entities (not hidden/diagnostic), optionally of some domains.
    areaEntities(areaId, domains) {
      return Object.keys(this.states).filter((id) => this.areaOf(id) === areaId && !this.isClutter(id) &&
        (!domains || domains.includes(domainOf(id))));
    }
    sortedAreas() {
      return [...this.areas.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    // { mdi: codePoint } or { text } for an entity; `override` is the widget's own icon (emoji or mdi:name).
    iconFor(id, override) {
      if (override) {
        const cp = mdi(override);
        return cp ? { mdi: cp } : { text: override };
      }
      const st = this.states[id];
      const a = (st && st.attributes) || {};
      const reg = this.registry.get(id);
      const cp = mdi((reg && reg.icon) || a.icon);
      if (cp) return { mdi: cp };
      if (domainOf(id) === 'lock' && st && st.state !== 'locked') return { text: '🔓' };
      return { text: CLASS_ICON[a.device_class] || DOMAIN_ICON[domainOf(id)] || '◻︎' };
    }
    setIcon(el, id, override) {
      const ic = this.iconFor(id, override);
      el.classList.toggle('mdi', !!ic.mdi);
      el.textContent = ic.mdi ? String.fromCodePoint(ic.mdi) : ic.text;
    }

    // Settings and Setup: what the status means and what to do about it.
    statusInfo() {
      let host = this.url;
      try { host = new URL(this.url).host; } catch (e) {}
      switch (this.status) {
        case 'connected': {
          const n = Object.keys(this.states).length;
          const where = this.info.name ? `“${this.info.name}”` : 'Home Assistant';
          return { ok: true, text: `✓ Connected to ${where}` + (this.info.version ? ` (Home Assistant ${this.info.version})` : '') + (n ? ` · ${n} entities` : '') };
        }
        case 'connecting': return { ok: null, text: `Connecting to ${host}…` };
        case 'auth failed': return { ok: false, text: '✗ Home Assistant turned the token down.', hint: 'Create a new long-lived access token and paste it in. A token stops working if it’s deleted in Home Assistant.' };
        case 'bad URL': return { ok: false, text: '✗ That address doesn’t look right.', hint: 'It should look like http://homeassistant.local:8123.' };
        case 'offline':
          if (this.everConnected) return { ok: false, text: `✗ Lost the connection to ${host}. Trying again…` };
          return {
            ok: false, text: `✗ Can’t reach ${host}.`,
            hint: /\.local(:|$)/.test(host)
              ? 'Check the address. If homeassistant.local doesn’t work, try its IP address instead, e.g. http://192.168.1.20:8123.'
              : /^https:/.test(this.url)
                ? 'Check the address. If it uses a self-signed certificate, macOS won’t trust it: use http:// on your home network, or a trusted certificate.'
                : 'Check the address and port (usually 8123), and that this Mac is on the same network.',
          };
        default:
          return { ok: null, text: this.url ? 'Paste a long-lived access token to connect.' : 'Enter your Home Assistant’s address and a token to connect.' };
      }
    }

    // How many entities of each type: [[label, count], …] (hidden and diagnostic ones left out).
    typeCounts() {
      const counts = new Map();
      for (const id of Object.keys(this.states)) {
        if (this.isClutter(id)) continue;
        const t = typeOf(id);
        counts.set(t, (counts.get(t) || 0) + 1);
      }
      return TYPES.filter(([k]) => counts.get(k)).map(([k, label]) => [label, counts.get(k), k]);
    }

    // Widgets for a set of entities, in the order given: sensors share glance tiles,
    // scenes and scripts share a strip of buttons, cameras get a camera tile.
    // Returns [{ w, h, widget }] for packing onto pages.
    tilesFor(ids) {
      const items = [];
      const groups = {};
      const grouped = (kind, id, make) => {
        if (!groups[kind]) { groups[kind] = []; items.push({ kind, make }); }
        groups[kind].push(id);
      };
      for (const id of ids) {
        const d = domainOf(id);
        if (d === 'camera') items.push({ w: 4, h: 2, widget: { type: 'ha-camera', entity: id, refresh: 5 } });
        else if (d === 'sensor' || d === 'binary_sensor') grouped('glance', id);
        else if (['scene', 'script', 'button', 'input_button'].includes(d)) grouped('scenes', id);
        else if (d === 'climate') items.push({ w: 4, h: 1, widget: { type: 'ha-entity', entity: id, showSlider: true, confirmLock: true } });
        else items.push({ w: 3, h: 1, widget: { type: 'ha-entity', entity: id, showSlider: true, confirmLock: true } });
      }
      const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
      return items.flatMap((it) => {
        if (!it.kind) return [it];
        const list = groups[it.kind];
        if (it.kind === 'glance') {
          if (list.length === 1) return [{ w: 3, h: 1, widget: { type: 'ha-entity', entity: list[0], showSlider: true, confirmLock: true } }];
          return chunk(list, 4).map((c) => ({ w: Math.min(8, c.length * 2), h: 1, widget: { type: 'ha-glance', entities: c, showNames: true } }));
        }
        return chunk(list, 6).map((c) => ({ w: Math.min(12, c.length * 2), h: 1, widget: { type: 'ha-scenes', entities: c } }));
      });
    }

    // ---------- Mock for browser preview (URL "mock") ----------
    startMock() {
      this.mock = true;
      const now = Date.now();
      const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
      const mk = (id, state, attrs, minsAgo = 30) => ({ entity_id: id, state, attributes: attrs, last_changed: iso(minsAgo), last_updated: iso(minsAgo) });
      const list = [
        mk('light.office', 'on', { friendly_name: 'Office', brightness: 180, color_temp_kelvin: 3600, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, supported_color_modes: ['color_temp'] }),
        mk('light.office_lamp', 'off', { friendly_name: 'Office lamp', supported_color_modes: ['brightness'] }),
        mk('light.lounge', 'off', { friendly_name: 'Lounge lamps', supported_color_modes: ['brightness'] }),
        mk('light.kitchen', 'on', { friendly_name: 'Kitchen', supported_color_modes: ['onoff'] }),
        mk('light.garden', 'off', { friendly_name: 'Garden lights', supported_color_modes: ['brightness'], icon: 'mdi:string-lights' }),
        mk('light.landing', 'unavailable', { friendly_name: 'Landing bulb', supported_color_modes: ['brightness'] }, 135),
        mk('switch.hot_tub_heater', 'on', { friendly_name: 'Hot tub heater', icon: 'mdi:hot-tub' }),
        mk('input_boolean.in_a_meeting', 'off', { friendly_name: 'In a meeting', icon: 'mdi:account-voice' }),
        mk('input_boolean.microphone_on', 'off', { friendly_name: 'Microphone on', icon: 'mdi:microphone' }),
        mk('fan.office', 'off', { friendly_name: 'Office fan', percentage: 0, percentage_step: 33.3 }),
        mk('sensor.hot_tub_temperature', '37.5', { friendly_name: 'Hot tub', unit_of_measurement: '°C', device_class: 'temperature' }),
        mk('sensor.office_temperature', '21.3', { friendly_name: 'Office temperature', unit_of_measurement: '°C', device_class: 'temperature' }),
        mk('sensor.office_humidity', '48', { friendly_name: 'Office humidity', unit_of_measurement: '%', device_class: 'humidity' }),
        mk('sensor.lounge_temperature', '19.8', { friendly_name: 'Lounge temperature', unit_of_measurement: '°C', device_class: 'temperature' }),
        mk('sensor.polestar_battery', '82', { friendly_name: 'Polestar battery', unit_of_measurement: '%', device_class: 'battery' }),
        mk('sensor.house_power', '412', { friendly_name: 'House power', unit_of_measurement: 'W', device_class: 'power' }),
        mk('sensor.office_plug_signal', '-61', { friendly_name: 'Office plug signal strength', unit_of_measurement: 'dBm', device_class: 'signal_strength' }),
        mk('sensor.office_plug_uptime', iso(4000), { friendly_name: 'Office plug uptime', device_class: 'timestamp' }),
        mk('binary_sensor.front_door', 'off', { friendly_name: 'Front door', device_class: 'door' }),
        mk('binary_sensor.office_motion', 'on', { friendly_name: 'Office motion', device_class: 'motion' }, 2),
        mk('lock.front_door', 'locked', { friendly_name: 'Front door lock' }),
        mk('cover.office_blind', 'open', { friendly_name: 'Office blind', current_position: 60, device_class: 'blind' }),
        mk('climate.hallway', 'heat', { friendly_name: 'Heating', current_temperature: 20.5, temperature: 21, min_temp: 7, max_temp: 30, target_temp_step: 0.5, hvac_modes: ['off', 'heat', 'auto'] }),
        mk('media_player.lounge_speaker', 'playing', { friendly_name: 'Lounge speaker', volume_level: 0.35, is_volume_muted: false, media_title: 'Blue in Green', media_artist: 'Miles Davis', source: 'Spotify', source_list: ['Spotify', 'TV', 'Radio 6 Music'] }),
        mk('scene.movie_time', iso(2900), { friendly_name: 'Movie time' }),
        mk('scene.evening', iso(1500), { friendly_name: 'Evening' }),
        mk('script.goodnight', 'off', { friendly_name: 'Goodnight', icon: 'mdi:weather-night' }),
        mk('button.doorbell_chime', iso(600), { friendly_name: 'Doorbell chime' }),
        mk('automation.morning_lights', 'on', { friendly_name: 'Morning lights' }),
        mk('camera.drive', 'idle', { friendly_name: 'Drive', entity_picture: '' }),
        mk('alarm_control_panel.house', 'armed_home', { friendly_name: 'House alarm' }),
        mk('update.home_assistant_core', 'off', { friendly_name: 'Home Assistant Core update' }),
        mk('sensor.hidden_helper', '3', { friendly_name: 'Template helper' }),
      ];
      this.states = {};
      for (const s of list) this.states[s.entity_id] = s;
      const area = {
        office: ['light.office', 'light.office_lamp', 'fan.office', 'sensor.office_temperature', 'sensor.office_humidity', 'binary_sensor.office_motion', 'cover.office_blind', 'sensor.office_plug_signal', 'sensor.office_plug_uptime'],
        lounge: ['light.lounge', 'sensor.lounge_temperature', 'media_player.lounge_speaker'],
        kitchen: ['light.kitchen'],
        garden: ['light.garden', 'switch.hot_tub_heater', 'sensor.hot_tub_temperature', 'camera.drive'],
        hallway: ['light.landing', 'binary_sensor.front_door', 'lock.front_door', 'climate.hallway', 'alarm_control_panel.house'],
      };
      const areaOf = {};
      for (const [a, ids] of Object.entries(area)) for (const id of ids) areaOf[id] = a;
      this.applyRegistry(
        [['office', 'Office'], ['lounge', 'Lounge'], ['kitchen', 'Kitchen'], ['garden', 'Garden'], ['hallway', 'Hallway']].map(([area_id, name]) => ({ area_id, name })),
        [],
        {
          entity_categories: { 0: 'config', 1: 'diagnostic' },
          entities: list.map((s) => Object.assign({ ei: s.entity_id }, areaOf[s.entity_id] ? { ai: areaOf[s.entity_id] } : {},
            /signal|uptime/.test(s.entity_id) ? { ec: 1 } : {}, s.entity_id.startsWith('update.') ? { ec: 0 } : {},
            s.entity_id === 'sensor.hidden_helper' ? { hb: true } : {})),
        });
      this.info = { name: 'Home', version: '2026.11.1' };
      this.everConnected = true;
      this.setStatus('connected');
    }

    mockService(domain, service, target, data) {
      const ids = Array.isArray(target) ? target : target ? [target] : [];
      const stamp = new Date().toISOString();
      for (const id of ids) {
        const s = this.states[id];
        if (!s) continue;
        const a = s.attributes;
        const was = s.state;
        switch (service) {
          case 'toggle':
            if (domain === 'cover') s.state = s.state === 'open' ? 'closed' : 'open';
            else if (domain === 'climate') s.state = s.state === 'off' ? 'heat' : 'off';
            else s.state = s.state === 'on' ? 'off' : 'on';
            break;
          case 'turn_on':
            if (domain === 'scene' || domain === 'script') { if (domain === 'scene') s.state = stamp; break; }
            s.state = domain === 'climate' ? 'heat' : 'on';
            if (data.brightness_pct != null) a.brightness = Math.round(data.brightness_pct * 2.55);
            if (data.color_temp_kelvin != null) a.color_temp_kelvin = data.color_temp_kelvin;
            if (domain === 'light' && a.brightness == null && (a.supported_color_modes || []).some((m) => m !== 'onoff')) a.brightness = 255;
            break;
          case 'turn_off': s.state = 'off'; break;
          case 'press': s.state = stamp; break;
          case 'lock': s.state = 'locked'; break;
          case 'unlock': case 'open': s.state = domain === 'lock' ? 'unlocked' : 'open'; break;
          case 'open_cover': s.state = 'open'; a.current_position = 100; break;
          case 'close_cover': s.state = 'closed'; a.current_position = 0; break;
          case 'stop_cover': break;
          case 'set_cover_position': a.current_position = data.position; s.state = data.position > 0 ? 'open' : 'closed'; break;
          case 'set_temperature': a.temperature = data.temperature; break;
          case 'set_hvac_mode': s.state = data.hvac_mode; break;
          case 'set_percentage': a.percentage = data.percentage; s.state = data.percentage > 0 ? 'on' : 'off'; break;
          case 'media_play_pause': s.state = s.state === 'playing' ? 'paused' : 'playing'; break;
          case 'volume_set': a.volume_level = data.volume_level; break;
          case 'volume_mute': a.is_volume_muted = !!data.is_volume_muted; break;
          case 'select_source': a.source = data.source; break;
          case 'alarm_disarm': s.state = 'disarmed'; break;
          case 'alarm_arm_home': s.state = 'armed_home'; break;
          case 'alarm_arm_away': s.state = 'armed_away'; break;
        }
        if (s.state !== was) s.last_changed = stamp;
        s.last_updated = stamp;
        this.emit(id);
      }
      return Promise.resolve();
    }
  }

  // A slice of what get_services returns, for the preview.
  const f = (name, selector, extra = {}) => Object.assign({ name, selector }, extra);
  const MOCK_SERVICES = {
    homeassistant: { toggle: { name: 'Generic toggle', fields: {} }, turn_on: { name: 'Generic turn on', fields: {} }, turn_off: { name: 'Generic turn off', fields: {} } },
    light: {
      turn_on: { name: 'Turn on', fields: { transition: f('Transition', { number: { min: 0, max: 300, unit_of_measurement: 'seconds' } }), brightness_pct: f('Brightness', { number: { min: 0, max: 100, unit_of_measurement: '%' } }), color_temp_kelvin: f('Colour temperature', { color_temp: { unit: 'kelvin', min: 2000, max: 6500 } }), rgb_color: f('Colour', { color_rgb: {} }), advanced_fields: { collapsed: true, fields: {} } } },
      turn_off: { name: 'Turn off', fields: { transition: f('Transition', { number: { min: 0, max: 300, unit_of_measurement: 'seconds' } }) } },
      toggle: { name: 'Toggle', fields: {} },
    },
    switch: { turn_on: { name: 'Turn on', fields: {} }, turn_off: { name: 'Turn off', fields: {} }, toggle: { name: 'Toggle', fields: {} } },
    fan: { turn_on: { name: 'Turn on', fields: {} }, turn_off: { name: 'Turn off', fields: {} }, toggle: { name: 'Toggle', fields: {} }, set_percentage: { name: 'Set speed', fields: { percentage: f('Percentage', { number: { min: 0, max: 100, unit_of_measurement: '%' } }, { required: true }) } } },
    lock: { lock: { name: 'Lock', fields: {} }, unlock: { name: 'Unlock', fields: {} }, open: { name: 'Open', fields: {} } },
    cover: { open_cover: { name: 'Open', fields: {} }, close_cover: { name: 'Close', fields: {} }, stop_cover: { name: 'Stop', fields: {} }, toggle: { name: 'Toggle', fields: {} }, set_cover_position: { name: 'Set position', fields: { position: f('Position', { number: { min: 0, max: 100, unit_of_measurement: '%' } }, { required: true }) } } },
    climate: { set_temperature: { name: 'Set target temperature', fields: { temperature: f('Temperature', { number: { min: 0, max: 100, step: 0.5 } }) } }, set_hvac_mode: { name: 'Set mode', fields: { hvac_mode: f('Mode', { select: { options: ['off', 'heat', 'cool', 'auto'] } }) } }, turn_on: { name: 'Turn on', fields: {} }, turn_off: { name: 'Turn off', fields: {} }, toggle: { name: 'Toggle', fields: {} } },
    media_player: { media_play_pause: { name: 'Play/Pause', fields: {} }, media_next_track: { name: 'Next', fields: {} }, media_previous_track: { name: 'Previous', fields: {} }, volume_set: { name: 'Set volume', fields: { volume_level: f('Level', { number: { min: 0, max: 1, step: 0.01 } }, { required: true }) } }, select_source: { name: 'Select source', fields: { source: f('Source', { text: {} }, { required: true }) } } },
    scene: { turn_on: { name: 'Activate', fields: { transition: f('Transition', { number: { min: 0, max: 300 } }) } } },
    script: { turn_on: { name: 'Turn on', fields: {} }, goodnight: { name: 'Goodnight', fields: {} } },
    button: { press: { name: 'Press', fields: {} } },
    automation: { trigger: { name: 'Trigger', fields: { skip_condition: f('Skip conditions', { boolean: {} }) } }, turn_on: { name: 'Turn on', fields: {} }, turn_off: { name: 'Turn off', fields: {} }, toggle: { name: 'Toggle', fields: {} } },
    alarm_control_panel: { alarm_disarm: { name: 'Disarm', fields: { code: f('Code', { text: {} }) } }, alarm_arm_home: { name: 'Arm home', fields: {} }, alarm_arm_away: { name: 'Arm away', fields: {} } },
    notify: { notify: { name: 'Send a notification', fields: { message: f('Message', { text: {} }, { required: true }), title: f('Title', { text: {} }) } } },
  };

  Object.assign(HAClient.prototype, { describe, tapService, typeOf, domainOf, ago, ON_STATES });
  window.HA = new HAClient();
})();
