// Integration widgets: system stats, audio, calendar, weather, script and timer.
// Registered into window.Widgets alongside the core widgets in widgets.js.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const MIC = svg('M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z');
  const MIC_OFF = svg('M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z');

  // Repeats fn every ms, skipping while a previous run is in flight or the page is hidden.
  function poller(fn, ms) {
    let busy = false;
    const run = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try { await fn(); } catch (e) { /* each widget shows its own errors */ }
      busy = false;
    };
    run();
    const t = ms > 0 ? setInterval(run, ms) : null;
    return { run, stop: () => t && clearInterval(t) };
  }

  // Memory is reported in binary units (as Activity Monitor does); disk and network in decimal (as Finder does).
  function fmtBytes(n, base = 1000) {
    if (n == null || isNaN(n)) return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= base && i < units.length - 1) { n /= base; i++; }
    return (i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + units[i];
  }

  function spark(values, max) {
    if (values.length < 2) return '<div class="spark"></div>';
    const m = max || Math.max(1, ...values);
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${29 - Math.min(1, v / m) * 27}`).join(' ');
    return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
  }

  // ---------------- System stats ----------------
  const HISTORY = 40;
  const system = {
    name: 'System stats',
    size: [5, 1],
    props: [
      { key: 'showCpu', label: 'CPU', type: 'bool', default: true },
      { key: 'showMemory', label: 'Memory', type: 'bool', default: true },
      { key: 'showNetwork', label: 'Network', type: 'bool', default: true },
      { key: 'showDisk', label: 'Disk', type: 'bool', default: true },
      { key: 'showBattery', label: 'Battery (if this Mac has one)', type: 'bool', default: true },
      { key: 'refresh', label: 'Refresh every (seconds)', type: 'number', default: 2, min: 1, max: 60 },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      const cpuHist = [], rxHist = [];
      let d = null;
      const bar = (f, warn) => `<div class="sys-bar${warn ? ' warn' : ''}"><div style="width:${Math.max(0, Math.min(1, f)) * 100}%"></div></div>`;
      const cell = (label, value, sub, extra) =>
        `<div class="sys-cell"><div class="sys-label">${label}</div><div class="sys-value">${value}</div><div class="sys-sub">${sub || '&nbsp;'}</div>${extra || ''}</div>`;

      function render() {
        const x = d || {};
        const cells = [];
        if (s.showCpu !== false) cells.push(cell('CPU', x.cpu != null ? Math.round(x.cpu) + '%' : '–', '', spark(cpuHist, 100)));
        if (s.showMemory !== false && x.memory && x.memory.used != null) {
          const f = x.memory.used / x.memory.total;
          cells.push(cell('Memory', Math.round(f * 100) + '%', `${fmtBytes(x.memory.used, 1024)} of ${fmtBytes(x.memory.total, 1024)}`, bar(f, f > 0.9)));
        }
        if (s.showNetwork !== false) {
          const n = x.network;
          cells.push(cell('Network', n ? '↓ ' + fmtBytes(n.rx) + '/s' : '–', n ? '↑ ' + fmtBytes(n.tx) + '/s' : '', spark(rxHist)));
        }
        if (s.showDisk !== false && x.disk) {
          const f = 1 - x.disk.free / x.disk.total;
          cells.push(cell('Disk', fmtBytes(x.disk.free) + ' free', 'of ' + fmtBytes(x.disk.total), bar(f, f > 0.9)));
        }
        if (s.showBattery !== false && x.battery) {
          const b = x.battery;
          cells.push(cell('Battery', Math.round(b.percent) + '%', b.charging ? 'Charging' : b.pluggedIn ? 'Plugged in' : 'On battery', bar(b.percent / 100, b.percent < 20 && !b.pluggedIn)));
        }
        el.style.setProperty('--cells', cells.length || 1);
        el.innerHTML = cells.join('') || '<div class="sys-empty">Choose some stats in the editor</div>';
      }

      render();
      const p = poller(async () => {
        d = await ctx.bridge.call('system.stats');
        if (d.cpu != null) { cpuHist.push(d.cpu); if (cpuHist.length > HISTORY) cpuHist.shift(); }
        if (d.network) { rxHist.push(d.network.rx); if (rxHist.length > HISTORY) rxHist.shift(); }
        render();
      }, (ctx.edit ? 10 : Math.max(1, Number(s.refresh) || 2)) * 1000);
      return { destroy: p.stop };
    },
  };

  // ---------------- Audio: mic mute and device switching ----------------
  const audio = {
    name: 'Audio (mic / devices)',
    size: [2, 1],
    props: [
      { key: 'mode', label: 'Shows', type: 'select', default: 'mic', options: [['mic', 'Microphone mute button'], ['output', 'Output device switcher'], ['input', 'Input device switcher']] },
      { key: 'hide', label: 'Hide devices containing', type: 'text', placeholder: 'Teams, iPhone', hint: 'Comma-separated. The current device is always shown.', showIf: (w) => w.mode === 'output' || w.mode === 'input' },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      const mode = s.mode || 'mic';
      const hide = (s.hide || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      let state = null;
      let lastList = '';

      if (mode === 'mic') {
        el.classList.add('pressable', 'audio-mic');
        el.innerHTML = '<div class="mic-icon"></div><div class="mic-text"><div class="mic-state">…</div><div class="mic-name"></div></div>';
        el._edgeTap = async () => {
          if (state && state.micMuted != null) { state.micMuted = !state.micMuted; render(); }
          try {
            const r = await ctx.bridge.call('audio.micMute');
            state = Object.assign(state || {}, r);
          } catch (e) { ctx.toast(e.message, 'error'); }
          p.run();
        };
      } else {
        el.classList.add('audio-list');
        el.innerHTML = `<div class="audio-title">${mode === 'output' ? 'Output' : 'Input'}</div><div class="audio-devices">…</div>`;
      }

      function render() {
        if (mode === 'mic') {
          const known = !!state && state.micMuted != null;
          const muted = known && state.micMuted;
          el.classList.toggle('muted', muted);
          el.querySelector('.mic-icon').innerHTML = muted ? MIC_OFF : MIC;
          el.querySelector('.mic-state').textContent = !state ? '…' : !known ? 'No mute control' : muted ? 'Mic muted' : 'Mic on';
          el.querySelector('.mic-name').textContent = (state && state.micName) || '';
          return;
        }
        const all = (state && state[mode === 'output' ? 'outputs' : 'inputs']) || [];
        const list = all.filter((d) => d.default || !hide.some((h) => d.name.toLowerCase().includes(h)));
        // Only rebuild the buttons when something changed, so a press in progress isn't wiped out.
        const sig = JSON.stringify(list);
        if (sig === lastList) return;
        lastList = sig;
        const box = el.querySelector('.audio-devices');
        box.innerHTML = '';
        if (!list.length) { box.textContent = state ? 'No devices' : '…'; return; }
        for (const d of list) {
          const b = document.createElement('button');
          b.className = 'audio-dev pressable' + (d.default ? ' on' : '');
          b.textContent = d.name;
          b._edgeTap = async () => {
            try {
              state = await ctx.bridge.call(mode === 'output' ? 'audio.setOutput' : 'audio.setInput', { id: d.id });
              render();
            } catch (e) { ctx.toast(e.message, 'error'); }
          };
          box.appendChild(b);
        }
      }

      render();
      const p = poller(async () => { state = await ctx.bridge.call('audio.state'); render(); }, ctx.edit ? 10000 : 2000);
      return { destroy: p.stop };
    },
  };

  // ---------------- Calendar ----------------
  const calendar = {
    name: 'Calendar',
    size: [4, 2],
    props: [
      { key: 'days', label: 'Days ahead', type: 'number', default: 2, min: 1, max: 14 },
      { key: 'limit', label: 'Most events shown', type: 'number', default: 6, min: 1, max: 20 },
      { key: 'calendars', label: 'Only these calendars', type: 'text', placeholder: 'Work, Home', hint: 'Comma-separated calendar names. Leave blank for all.' },
      { key: 'allDay', label: 'Include all-day events', type: 'bool', default: true },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      let events = null;
      let error = '';
      const dayKey = (ms) => new Date(ms).toDateString();
      const timeFmt = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      function dayLabel(ms) {
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        if (dayKey(ms) === dayKey(now)) return 'Today';
        if (dayKey(ms) === dayKey(tomorrow)) return 'Tomorrow';
        return new Date(ms).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
      }
      function rel(e, now) {
        if (e.allDay) return '';
        if (e.start <= now) return 'Now · until ' + timeFmt(e.end);
        const m = Math.round((e.start - now) / 60000);
        if (m < 60) return 'in ' + m + ' min';
        if (m < 12 * 60 && dayKey(e.start) === dayKey(now)) return 'in ' + Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
        return '';
      }

      function render() {
        const now = Date.now();
        if (error) { el.innerHTML = `<div class="cal-msg">${esc(error)}</div>`; return; }
        if (!events) { el.innerHTML = '<div class="cal-msg">Loading…</div>'; return; }
        const list = events.filter((e) => e.end > now);
        if (!list.length) { el.innerHTML = '<div class="cal-msg">Nothing coming up</div>'; return; }
        const headers = list.some((e) => dayKey(Math.max(e.start, now)) !== dayKey(now));
        let html = '';
        let lastDay = '';
        list.forEach((e, i) => {
          const dk = dayKey(Math.max(e.start, now));   // events in progress count as today
          if (headers && dk !== lastDay) { html += `<div class="cal-day">${dayLabel(Math.max(e.start, now))}</div>`; lastDay = dk; }
          const live = !e.allDay && e.start <= now;
          const soon = !e.allDay && !live && e.start - now < 10 * 60000;
          const sub = [rel(e, now), e.location && !e.joinURL ? e.location : ''].filter(Boolean).join(' · ');
          html += `<div class="cal-event${live ? ' live' : ''}${soon ? ' soon' : ''}" style="--cal:${esc(e.color || '')}">
            <div class="cal-bar"></div>
            <div class="cal-time">${e.allDay ? 'All day' : timeFmt(e.start)}</div>
            <div class="cal-main"><div class="cal-title">${esc(e.title)}</div>${sub ? `<div class="cal-sub">${esc(sub)}</div>` : ''}</div>
            ${e.joinURL ? `<button class="cal-join pressable" data-i="${i}">Join</button>` : ''}
          </div>`;
        });
        el.innerHTML = html;
        el.querySelectorAll('.cal-join').forEach((b) => {
          b._edgeTap = () => ctx.bridge.call('action.run', { type: 'url', target: list[+b.dataset.i].joinURL }).catch((e) => ctx.toast(e.message, 'error'));
        });
      }

      render();
      const p = poller(async () => {
        try {
          events = await ctx.bridge.call('calendar.events', { days: Number(s.days) || 2, limit: Number(s.limit) || 6, calendars: s.calendars || '', allDay: s.allDay !== false });
          error = '';
        } catch (e) { error = e.message; }
        render();
      }, ctx.edit ? 300000 : 60000);
      const tick = setInterval(render, 30000);   // keep "in 5 min" current between fetches
      return { destroy() { p.stop(); clearInterval(tick); } };
    },
  };

  // ---------------- Weather (Open-Meteo, no API key) ----------------
  const WMO = {
    0: ['Clear', '☀️', '🌙'], 1: ['Mainly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️'],
    45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
    51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
    61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
    71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
    80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '🌧️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '🌨️'],
    95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
  };
  const wmo = (code, night) => {
    const w = WMO[code] || ['–', '🌡️'];
    return { text: w[0], icon: night && w[2] ? w[2] : w[1] };
  };

  async function geocode(place) {
    const m = place.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { lat: +m[1], lon: +m[2], name: '' };
    const key = 'edgedeck.geo.' + place.trim().toLowerCase();
    try { const c = JSON.parse(localStorage.getItem(key)); if (c) return c; } catch (e) { /* no storage */ }
    const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' + encodeURIComponent(place.trim()));
    if (!r.ok) throw new Error('Location lookup failed');
    const g = ((await r.json()).results || [])[0];
    if (!g) throw new Error(`Couldn't find "${place}"`);
    const out = { lat: g.latitude, lon: g.longitude, name: g.name };
    try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) { /* no storage */ }
    return out;
  }

  const weather = {
    name: 'Weather',
    size: [4, 2],
    props: [
      { key: 'location', label: 'Location', type: 'text', placeholder: 'London', hint: 'A town or city, or "latitude, longitude".' },
      { key: 'units', label: 'Units', type: 'select', default: 'c', options: [['c', '°C'], ['f', '°F']] },
      { key: 'forecastDays', label: 'Forecast days', type: 'number', default: 3, min: 0, max: 6 },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s) {
      let data = null;
      let place = null;
      let error = '';

      function render() {
        if (!s.location) { el.innerHTML = '<div class="wx-msg">Set a location in the editor</div>'; return; }
        if (error && !data) { el.innerHTML = `<div class="wx-msg">${esc(error)}</div>`; return; }
        if (!data) { el.innerHTML = '<div class="wx-msg">Loading…</div>'; return; }
        const c = data.current, dl = data.daily;
        const now = wmo(c.weather_code, c.is_day === 0);
        const days = Math.max(0, Math.min(6, Number(s.forecastDays ?? 3)));
        let fc = '';
        for (let i = 1; i <= days && i < dl.time.length; i++) {
          const w = wmo(dl.weather_code[i]);
          const name = new Date(dl.time[i] + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short' });
          fc += `<div class="wx-day"><div class="wx-dname">${name}</div><div class="wx-dicon">${w.icon}</div><div class="wx-drange">${Math.round(dl.temperature_2m_max[i])}° <span>${Math.round(dl.temperature_2m_min[i])}°</span></div></div>`;
        }
        el.innerHTML = `
          <div class="wx-now">
            <div class="wx-icon">${now.icon}</div>
            <div class="wx-main">
              <div class="wx-temp">${Math.round(c.temperature_2m)}°</div>
              <div class="wx-desc">${esc(now.text)}</div>
              <div class="wx-sub">H ${Math.round(dl.temperature_2m_max[0])}° · L ${Math.round(dl.temperature_2m_min[0])}°${place && place.name ? ' · ' + esc(place.name) : ''}</div>
            </div>
          </div>
          ${fc ? `<div class="wx-forecast">${fc}</div>` : ''}`;
      }

      let timer = null;
      async function load() {
        clearTimeout(timer);
        if (!s.location) return render();
        try {
          place = place || await geocode(s.location);
          const unit = s.units === 'f' ? '&temperature_unit=fahrenheit' : '';
          const days = Math.max(1, Math.min(7, Number(s.forecastDays ?? 3) + 1));
          const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
            `&current=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${days}${unit}`);
          if (!r.ok) throw new Error('Weather service error ' + r.status);
          data = await r.json();
          error = '';
          timer = setTimeout(load, 15 * 60000);
        } catch (e) {
          error = e.message || 'No connection';
          timer = setTimeout(load, 2 * 60000);
        }
        render();
      }

      render();
      load();
      return { destroy: () => clearTimeout(timer) };
    },
  };

  // ---------------- Script (AppleScript / JXA) ----------------
  const script = {
    name: 'Script',
    size: [2, 1],
    props: [
      { key: 'label', label: 'Label', type: 'text' },
      { key: 'language', label: 'Language', type: 'select', default: 'applescript', options: [['applescript', 'AppleScript'], ['jxa', 'JavaScript (JXA)']] },
      {
        key: 'source', label: 'Script (its result is shown)', type: 'textarea', placeholder: 'tell application "Mail" to get unread count of inbox',
        hint: 'Return text or a number, or JSON such as {"value":"3","title":"Inbox","subtitle":"unread","icon":"✉️","color":"#7a2030"}. In JXA, finish with JSON.stringify(…). The first run may ask to allow EdgeDeck to control the app.',
      },
      { key: 'refresh', label: 'Re-run every (seconds, 0 = only when tapped)', type: 'number', default: 60, min: 0, max: 86400 },
      { key: 'tapSource', label: 'Script to run when tapped (optional)', type: 'textarea', hint: 'Same language. The result above refreshes afterwards. Leave blank to just re-run it.' },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.classList.add('pressable');
      el.innerHTML = '<div class="scr-icon"></div><div class="scr-text"><div class="scr-value"></div><div class="scr-title"></div><div class="scr-sub"></div></div>';
      const $ = (q) => el.querySelector(q);
      const lang = s.language || 'applescript';

      function show(result, error) {
        let r = result;
        if (r == null || typeof r !== 'object' || Array.isArray(r)) r = { value: Array.isArray(r) ? r.join(', ') : r };
        $('.scr-icon').textContent = error ? '⚠︎' : (r.icon || '');
        $('.scr-value').textContent = error ? 'Script error' : (r.value ?? '');
        $('.scr-title').textContent = r.title || s.label || '';
        $('.scr-sub').textContent = error || r.subtitle || '';
        el.classList.toggle('has-icon', !!(error || r.icon));
        el.classList.toggle('failed', !!error);
        el.style.setProperty('--tile', (!error && r.color) || s.color || '');
      }

      async function run() {
        if (!s.source) { show({ value: ctx.edit ? 'Add a script' : '' }); return; }
        try { show(await ctx.bridge.call('script.run', { language: lang, source: s.source })); }
        catch (e) { show(null, e.message); EdgeBridge.log('Script widget: ' + e.message); }
      }

      el._edgeTap = async () => {
        if (s.tapSource) {
          try { await ctx.bridge.call('script.run', { language: lang, source: s.tapSource }); }
          catch (e) { ctx.toast(e.message, 'error'); }
        }
        p.run();
      };

      show({ value: '…' });
      // In the editor, run once rather than repeatedly, in case the script changes things.
      const p = poller(run, ctx.edit ? 0 : Math.max(0, Number(s.refresh ?? 60)) * 1000);
      return { destroy: p.stop };
    },
  };

  // ---------------- Timer / stopwatch ----------------
  // State lives outside the widget so a running timer survives the dashboard re-rendering.
  const timers = new Map();
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      for (let i = 0; i < 3; i++) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = 880;
        o.connect(g);
        g.connect(audioCtx.destination);
        const t = t0 + i * 0.35;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        o.start(t);
        o.stop(t + 0.3);
      }
    } catch (e) { /* no audio */ }
  }

  const timer = {
    name: 'Timer / stopwatch',
    size: [2, 1],
    props: [
      { key: 'mode', label: 'Type', type: 'select', default: 'timer', options: [['timer', 'Countdown timer'], ['stopwatch', 'Stopwatch']] },
      { key: 'minutes', label: 'Minutes', type: 'number', default: 25, min: 1, max: 600, showIf: (w) => (w.mode || 'timer') === 'timer' },
      { key: 'label', label: 'Label', type: 'text' },
      { key: 'sound', label: 'Beep when finished', type: 'bool', default: true, showIf: (w) => (w.mode || 'timer') === 'timer' },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.classList.add('pressable');
      el.innerHTML = '<div class="tmr-label"></div><div class="tmr-time"></div><div class="tmr-hint"></div><div class="tmr-bar"><div></div></div>';
      const $ = (q) => el.querySelector(q);
      const isTimer = (s.mode || 'timer') === 'timer';
      const total = Math.max(1, Number(s.minutes) || 25) * 60000;
      const key = s.id + ':' + (s.mode || 'timer') + ':' + total;
      const st = timers.get(key) || { running: false, startedAt: 0, elapsed: 0, done: false };
      timers.set(key, st);

      const elapsed = () => st.elapsed + (st.running ? Date.now() - st.startedAt : 0);
      function fmt(ms) {
        const secs = isTimer ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
        const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60;
        return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
      }
      const reset = () => Object.assign(st, { running: false, startedAt: 0, elapsed: 0, done: false });

      el._edgeTap = () => {
        if (st.done) reset();
        else if (st.running) { st.elapsed = elapsed(); st.running = false; }
        else { st.startedAt = Date.now(); st.running = true; }
        render();
      };
      el._edgeLong = () => { reset(); render(); };

      function render() {
        const e = elapsed();
        if (isTimer && st.running && e >= total) {
          Object.assign(st, { running: false, elapsed: total, done: true });
          if (s.sound !== false && !ctx.edit) beep();
        }
        const shown = isTimer ? Math.max(0, total - e) : e;
        $('.tmr-label').textContent = s.label || (isTimer ? 'Timer' : 'Stopwatch');
        $('.tmr-time').textContent = fmt(shown);
        $('.tmr-hint').textContent = st.done ? "Time's up · tap to reset" : st.running ? 'Tap to pause · hold to reset' : e > 0 ? 'Paused · hold to reset' : 'Tap to start';
        $('.tmr-bar').style.display = isTimer ? '' : 'none';
        $('.tmr-bar div').style.width = Math.min(1, e / total) * 100 + '%';
        el.classList.toggle('running', st.running);
        el.classList.toggle('done', st.done);
      }

      render();
      const t = setInterval(render, 250);
      return { destroy: () => clearInterval(t) };
    },
  };

  Object.assign(window.Widgets, { system, audio, calendar, weather, script, timer });
})();
