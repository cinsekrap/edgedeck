// Widget types. Each has create(el, settings, ctx) -> { destroy() }.
(function () {
  const svg = (d, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    play: svg('M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z'),
    pause: svg('M7 4h3.5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm6.5 0H17a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z'),
    next: svg('M4 6.2v11.6a1 1 0 0 0 1.53.85L14 13.3v4.5a1 1 0 0 0 1.53.85l8-5.8a1 1 0 0 0 0-1.7l-8-5.8A1 1 0 0 0 14 6.2v4.5L5.53 5.35A1 1 0 0 0 4 6.2z'),
    prev: svg('M20 6.2v11.6a1 1 0 0 1-1.53.85L10 13.3v4.5a1 1 0 0 1-1.53.85l-8-5.8a1 1 0 0 1 0-1.7l8-5.8A1 1 0 0 1 10 6.2v4.5l8.47-5.35A1 1 0 0 1 20 6.2z'),
    volume: svg('M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z'),
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  // Horizontal slider usable by touch and mouse. onChange(fraction, final)
  function makeSlider(el, onChange) {
    let rect = null;
    const frac = (x) => Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    el._edgeDrag = {
      start(x) { rect = el.getBoundingClientRect(); el.classList.add('dragging'); onChange(frac(x), false); },
      move(x) { onChange(frac(x), false); },
      end(x) { el.classList.remove('dragging'); onChange(frac(x), true); },
    };
  }

  function throttle(fn, ms) {
    let last = 0, timer = null, lastArgs;
    return (...args) => {
      lastArgs = args;
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn(...args);
      } else {
        clearTimeout(timer);
        timer = setTimeout(() => { last = Date.now(); fn(...lastArgs); }, ms - (now - last));
      }
    };
  }

  // ---------------- Clock ----------------
  const clock = {
    name: 'Clock',
    size: [3, 2],
    props: [
      { key: 'format24', label: '24-hour time', type: 'bool', default: true },
      { key: 'showSeconds', label: 'Show seconds', type: 'bool', default: false },
      { key: 'showDate', label: 'Show date', type: 'bool', default: true },
    ],
    create(el, s) {
      el.innerHTML = '<div class="clock-time"></div><div class="clock-date"></div>';
      const t = el.querySelector('.clock-time');
      const d = el.querySelector('.clock-date');
      const tick = () => {
        const now = new Date();
        const opts = { hour: '2-digit', minute: '2-digit', hour12: s.format24 === false };
        if (s.showSeconds) opts.second = '2-digit';
        t.textContent = now.toLocaleTimeString('en-GB', opts).replace(/^0(?=\d:)/, '');
        d.textContent = s.showDate === false ? '' : now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      };
      tick();
      const timer = setInterval(tick, 1000);
      return { destroy: () => clearInterval(timer) };
    },
  };

  // ---------------- Now Playing ----------------
  const media = {
    name: 'Now Playing',
    size: [5, 2],
    props: [
      { key: 'showVolume', label: 'Show volume slider', type: 'bool', default: true },
      { key: 'blurArtwork', label: 'Artwork as background', type: 'bool', default: true },
    ],
    create(el, s, ctx) {
      el.innerHTML = `
        <div class="np-bg"></div>
        <div class="np-art"><div class="np-art-empty">♪</div><img alt=""></div>
        <div class="np-body">
          <div class="np-app"></div>
          <div class="np-title">Nothing playing</div>
          <div class="np-artist"></div>
          <div class="np-progress slider"><div class="track"><div class="fill"></div><div class="knob"></div></div></div>
          <div class="np-times"><span class="np-pos"></span><span class="np-dur"></span></div>
          <div class="np-controls">
            <button class="np-btn pressable" data-a="previous">${ICON.prev}</button>
            <button class="np-btn np-play pressable" data-a="playpause">${ICON.play}</button>
            <button class="np-btn pressable" data-a="next">${ICON.next}</button>
          </div>
          <div class="np-volume slider"><span class="vol-icon">${ICON.volume}</span><div class="track"><div class="fill"></div><div class="knob"></div></div></div>
        </div>`;
      el.classList.toggle('compact', s.h < 2 || s.w < 4);
      const $ = (q) => el.querySelector(q);
      const img = $('.np-art img');
      const bg = $('.np-bg');
      const progress = $('.np-progress');
      const volume = $('.np-volume');
      if (s.showVolume === false) volume.style.display = 'none';
      let state = { state: 'stopped' };
      let fetchedAt = Date.now();
      let seeking = null;
      let volDragging = false;

      el.querySelectorAll('.np-btn').forEach((b) => {
        b._edgeTap = () => {
          const a = b.dataset.a;
          if (a === 'playpause') {
            state.state = state.state === 'playing' ? 'paused' : 'playing';
            render();
          }
          ctx.bridge.call('media.control', { action: a }).then(() => setTimeout(poll, 350));
        };
      });

      makeSlider(progress, (f, final) => {
        if (!state.duration) return;
        seeking = f * state.duration;
        render();
        if (final) {
          ctx.bridge.call('media.seek', { position: seeking }).then(() => {
            state.position = seeking;
            fetchedAt = Date.now();
            seeking = null;
            setTimeout(poll, 300);
          });
        }
      });

      const sendVolume = throttle((v) => ctx.bridge.call('volume.set', { value: v }), 60);
      makeSlider(volume, (f, final) => {
        volDragging = !final;
        state.volume = Math.round(f * 100);
        sendVolume(state.volume);
        render();
      });

      function setFill(slider, f) {
        slider.querySelector('.fill').style.width = f * 100 + '%';
        slider.querySelector('.knob').style.left = f * 100 + '%';
      }

      function render() {
        const playing = state.state === 'playing';
        const has = !!state.title;
        el.classList.toggle('idle', !has);
        $('.np-app').textContent = has ? (state.app || '') + (playing ? '' : ' · paused') : '';
        $('.np-title').textContent = has ? state.title : 'Nothing playing';
        $('.np-artist').textContent = has ? [state.artist, state.album].filter(Boolean).join(' — ') : 'Start something in Spotify or Music';
        $('.np-play').innerHTML = playing ? ICON.pause : ICON.play;
        const pos = seeking != null ? seeking : (state.position || 0) + (playing ? (Date.now() - fetchedAt) / 1000 : 0);
        const dur = state.duration || 0;
        setFill(progress, dur ? Math.min(1, pos / dur) : 0);
        $('.np-pos').textContent = dur ? fmtTime(pos) : '';
        $('.np-dur').textContent = dur ? fmtTime(dur) : '';
        setFill(volume, (state.volume || 0) / 100);
        const art = state.artwork || '';
        if (img.dataset.src !== art) {
          img.dataset.src = art;
          if (art) img.src = art; else img.removeAttribute('src');
          img.style.display = art ? '' : 'none';
          bg.style.backgroundImage = art && s.blurArtwork !== false ? `url("${art}")` : '';
        }
      }

      let busy = false;
      async function poll() {
        if (busy || document.hidden) return;
        busy = true;
        try {
          const next = await ctx.bridge.call('media.state');
          if (next) {
            const vol = state.volume;
            state = next;
            if (volDragging) state.volume = vol;
            fetchedAt = Date.now();
            render();
          }
        } catch (e) { /* ignore */ }
        busy = false;
      }

      render();
      poll();
      const pollTimer = setInterval(poll, ctx.edit ? 4000 : 1500);
      const tickTimer = setInterval(() => { if (state.state === 'playing') render(); }, 500);
      return { destroy() { clearInterval(pollTimer); clearInterval(tickTimer); } };
    },
  };

  // ---------------- Key (Stream Deck style) ----------------
  async function runKeyAction(s, ctx) {
    const type = s.actionType || 'none';
    const target = s.actionTarget || '';
    if (type === 'none') return;
    if (type === 'page') return ctx.pages.goByName(target);
    if (type === 'profile') return window.EdgeDeck.switchProfile(target);
    if (type === 'ha') {
      const [domain, service] = (target || '').split('.');
      if (!domain || !service) throw new Error('Set the Home Assistant service, e.g. light.toggle');
      return ctx.ha.callService(domain, service, s.actionEntity || undefined);
    }
    if (type === 'teams') {
      const [action, param] = (target || 'toggle-mute').split(':');
      return window.EdgeTeams.action(action, param);
    }
    if (type === 'media') {
      if (target === 'volup' || target === 'voldown') {
        const st = await ctx.bridge.call('media.state');
        const v = Math.max(0, Math.min(100, (st.volume || 0) + (target === 'volup' ? 6 : -6)));
        return ctx.bridge.call('volume.set', { value: v });
      }
      if (target === 'mute') return ctx.bridge.call('volume.mute');
      if (target === 'micmute') return ctx.bridge.call('audio.micMute');
      return ctx.bridge.call('media.control', { action: target });
    }
    return ctx.bridge.call('action.run', { type, target });
  }

  const ON_STATES = new Set(['on', 'open', 'unlocked', 'playing', 'home', 'heat', 'cool', 'active']);

  const key = {
    name: 'Key',
    size: [1, 1],
    props: [
      { key: 'label', label: 'Label', type: 'text' },
      {
        key: 'actionType', label: 'When tapped', type: 'select', default: 'app',
        options: [['app', 'Open app'], ['shortcut', 'Run Shortcut'], ['keys', 'Keyboard shortcut'], ['url', 'Open URL'],
          ['media', 'Media / volume'], ['ha', 'Home Assistant service'], ['shell', 'Shell command'], ['applescript', 'AppleScript'], ['jxa', 'JavaScript (JXA)'], ['teams', 'Meeting control (Teams / Zoom)'], ['page', 'Go to page'], ['profile', 'Switch profile'], ['none', 'Nothing']],
      },
      { key: 'actionTarget', label: 'App', type: 'app', showIf: (w) => w.actionType === 'app' },
      { key: 'actionTarget', label: 'Shortcut name', type: 'shortcut', showIf: (w) => w.actionType === 'shortcut' },
      { key: 'actionTarget', label: 'Keys', type: 'text', placeholder: 'cmd+shift+4', hint: 'Modifiers: cmd, shift, alt, ctrl, fn. Keys: a–z, 0–9, f1–f20, space, return, tab, esc, up/down/left/right.', showIf: (w) => w.actionType === 'keys' },
      { key: 'actionTarget', label: 'URL', type: 'text', placeholder: 'https://…', showIf: (w) => w.actionType === 'url' },
      { key: 'actionTarget', label: 'Media action', type: 'select', options: [['playpause', 'Play / pause'], ['next', 'Next track'], ['previous', 'Previous track'], ['mute', 'Mute / unmute'], ['volup', 'Volume up'], ['voldown', 'Volume down'], ['micmute', 'Mute / unmute microphone']], showIf: (w) => w.actionType === 'media' },
      { key: 'actionTarget', label: 'Service', type: 'text', placeholder: 'light.toggle', showIf: (w) => w.actionType === 'ha' },
      { key: 'actionEntity', label: 'Entity', type: 'entity', showIf: (w) => w.actionType === 'ha' },
      { key: 'actionTarget', label: 'Command', type: 'textarea', placeholder: 'open ~/Downloads', hint: 'Runs in zsh as you.', showIf: (w) => w.actionType === 'shell' },
      { key: 'actionTarget', label: 'Script', type: 'textarea', placeholder: 'tell application "Music" to playpause', hint: 'Runs through osascript. The first run may ask to allow EdgeDeck to control the app.', showIf: (w) => w.actionType === 'applescript' || w.actionType === 'jxa' },
      { key: 'actionTarget', label: 'Meeting action', type: 'select', options: [['toggle-mute', 'Mute / unmute'], ['toggle-video', 'Camera on / off'], ['toggle-hand', 'Raise / lower hand'], ['toggle-background-blur', 'Background blur'], ['leave-call', 'Leave meeting'], ['stop-sharing', 'Stop sharing'], ['toggle-ui:chat', 'Show / hide chat'], ['send-reaction:like', 'React 👍'], ['send-reaction:love', 'React ❤️'], ['send-reaction:applause', 'React 👏'], ['send-reaction:laugh', 'React 😂'], ['send-reaction:wow', 'React 😮']], showIf: (w) => w.actionType === 'teams' },
      {
        key: 'actionTarget', label: 'Profile', type: 'dynamic', showIf: (w) => w.actionType === 'profile',
        load: async () => ((window.EdgeDeck && EdgeDeck.State.config && EdgeDeck.State.config.profiles) || []).map((p) => [p.name, p.name]),
      },
      { key: 'actionTarget', label: 'Page (name or number)', type: 'page', showIf: (w) => w.actionType === 'page' },
      { key: 'iconType', label: 'Icon', type: 'select', default: 'auto', options: [['auto', 'Automatic'], ['emoji', 'Emoji or text'], ['image', 'Image URL'], ['none', 'None']] },
      { key: 'icon', label: 'Emoji / text', type: 'text', placeholder: '🎬', showIf: (w) => w.iconType === 'emoji' },
      { key: 'icon', label: 'Image URL', type: 'text', placeholder: 'https://…/icon.png', showIf: (w) => w.iconType === 'image' },
      { key: 'stateEntity', label: 'Light up when this entity is on', type: 'entity' },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.classList.add('pressable');
      el.innerHTML = '<div class="key-icon"></div><div class="key-label"></div>';
      const iconEl = el.querySelector('.key-icon');
      el.querySelector('.key-label').textContent = s.label || '';
      el.classList.toggle('no-label', !s.label);

      const iconType = s.iconType || 'auto';
      if (iconType === 'emoji' && s.icon) {
        iconEl.textContent = s.icon;
        iconEl.classList.add('emoji');
      } else if (iconType === 'image' && s.icon) {
        iconEl.innerHTML = `<img src="${esc(s.icon)}" alt="">`;
      } else if (iconType === 'auto' && s.actionType === 'app' && s.actionTarget) {
        ctx.bridge.call('app.icon', { target: s.actionTarget }).then((url) => {
          if (url) iconEl.innerHTML = `<img src="${url}" alt="">`;
          else { iconEl.textContent = (s.label || '?').slice(0, 1); iconEl.classList.add('letter'); }
        }).catch(() => {});
      } else if (iconType === 'auto') {
        const auto = { shortcut: '⚡️', keys: '⌘', url: '🔗', media: '♪', ha: '🏠', shell: '›_', applescript: '📜', jxa: '📜', teams: '👥', page: '→', profile: '🗂️' }[s.actionType];
        if (auto) { iconEl.textContent = auto; iconEl.classList.add('emoji'); }
      }
      if (!iconEl.innerHTML && iconType !== 'none' && !(iconType === 'auto' && s.actionType === 'app')) {
        el.classList.add('label-only');
      }

      el._edgeTap = () => {
        runKeyAction(s, ctx).catch((e) => {
          el.classList.add('error');
          setTimeout(() => el.classList.remove('error'), 600);
          ctx.toast(e.message, 'error');
        });
      };

      let unsub = null;
      if (s.stateEntity) {
        const update = (id) => {
          if (id !== '*' && id !== s.stateEntity) return;
          const st = ctx.ha.states[s.stateEntity];
          el.classList.toggle('on', !!st && ON_STATES.has(st.state));
        };
        unsub = ctx.ha.subscribe(update);
        update('*');
      }
      return { destroy() { unsub && unsub(); } };
    },
  };

  // ---------------- Home Assistant entity tile ----------------
  const DOMAIN_ICON = {
    light: '💡', switch: '⏻', fan: '🌀', climate: '🌡️', lock: '🔒', cover: '🪟', sensor: '📈',
    binary_sensor: '◉', media_player: '🔈', scene: '🎬', script: '📜', automation: '🤖',
    input_boolean: '⏻', button: '🔘', camera: '📷', person: '👤', vacuum: '🧹', water_heater: '♨️',
  };
  const CLASS_ICON = { temperature: '🌡️', humidity: '💧', battery: '🔋', power: '⚡️', energy: '⚡️', door: '🚪', window: '🪟', motion: '🏃', illuminance: '☀️' };

  function describe(st) {
    if (!st) return '';
    const a = st.attributes || {};
    const domain = st.entity_id.split('.')[0];
    if (st.state === 'unavailable') return 'Unavailable';
    if (domain === 'climate') {
      const cur = a.current_temperature != null ? a.current_temperature + '°' : '';
      const set = a.temperature != null ? ' → ' + a.temperature + '°' : '';
      return cur + set + (st.state === 'off' ? ' · off' : '');
    }
    if (domain === 'light' && st.state === 'on' && a.brightness != null) return Math.round(a.brightness / 2.55) + '%';
    if (a.unit_of_measurement) {
      const n = Number(st.state);
      return (isNaN(n) ? st.state : (Math.round(n * 10) / 10)) + (a.unit_of_measurement === '%' ? '%' : ' ' + a.unit_of_measurement);
    }
    return st.state.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }

  function tapService(st) {
    const domain = st.entity_id.split('.')[0];
    switch (domain) {
      case 'light': case 'switch': case 'fan': case 'input_boolean': case 'automation': case 'cover': case 'climate': case 'media_player':
        return domain === 'media_player' ? [domain, 'media_play_pause'] : [domain, 'toggle'];
      case 'lock': return [domain, st.state === 'locked' ? 'unlock' : 'lock'];
      case 'scene': case 'script': return [domain, 'turn_on'];
      case 'button': case 'input_button': return [domain, 'press'];
      default: return null;
    }
  }

  const haEntity = {
    name: 'Home Assistant entity',
    size: [3, 1],
    props: [
      { key: 'entity', label: 'Entity', type: 'entity' },
      { key: 'name', label: 'Name (optional)', type: 'text' },
      { key: 'icon', label: 'Icon (optional emoji)', type: 'text' },
      { key: 'showSlider', label: 'Brightness slider for lights', type: 'bool', default: true },
      { key: 'confirmLock', label: 'Hold to unlock locks', type: 'bool', default: true },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.classList.add('pressable');
      el.innerHTML = `
        <div class="ha-top"><div class="ha-icon"></div><div class="ha-text"><div class="ha-name"></div><div class="ha-state"></div></div></div>
        <div class="ha-slider slider"><div class="track"><div class="fill"></div><div class="knob"></div></div></div>`;
      const $ = (q) => el.querySelector(q);
      const slider = $('.ha-slider');
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

      function act(st) {
        const svc = tapService(st);
        if (!svc) return;
        ctx.ha.callService(svc[0], svc[1], s.entity).catch((e) => ctx.toast(e.message, 'error'));
      }

      el._edgeTap = () => {
        const st = ctx.ha.states[s.entity];
        if (!st) return;
        if (st.entity_id.startsWith('lock.') && st.state === 'locked' && s.confirmLock !== false) {
          ctx.toast('Hold to unlock');
          return;
        }
        act(st);
      };
      el._edgeLong = () => {
        const st = ctx.ha.states[s.entity];
        if (st) act(st);
      };

      function render(id) {
        if (id !== '*' && id !== s.entity) return;
        const st = ctx.ha.states[s.entity];
        const domain = (s.entity || '').split('.')[0];
        const a = (st && st.attributes) || {};
        let status = '';
        if (!s.entity) status = ctx.edit ? 'Choose an entity' : 'Not set up';
        else if (ctx.ha.status !== 'connected') status = ctx.ha.status === 'not configured' ? 'Home Assistant not set up' : 'Home Assistant ' + ctx.ha.status;
        else if (!st) status = 'Not found';
        $('.ha-name').textContent = s.name || a.friendly_name || s.entity || 'Home Assistant';
        $('.ha-state').textContent = status || describe(st);
        $('.ha-icon').textContent = s.icon || CLASS_ICON[a.device_class] || DOMAIN_ICON[domain] || '◻︎';
        const on = !!st && ON_STATES.has(st.state);
        el.classList.toggle('on', on);
        el.classList.toggle('unavailable', !st || st.state === 'unavailable');
        const dimmable = domain === 'light' && s.showSlider !== false && s.w >= 2 &&
          (a.brightness != null || (a.supported_color_modes || []).some((m) => m !== 'onoff'));
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
      return { destroy: unsub };
    },
  };

  // ---------------- Home Assistant camera ----------------
  const haCamera = {
    name: 'Home Assistant camera',
    size: [4, 2],
    props: [
      { key: 'entity', label: 'Camera entity', type: 'entity', domain: 'camera' },
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
        if (!s.entity) { msg.textContent = ctx.edit ? 'Choose a camera' : 'Not set up'; return; }
        if (ctx.ha.status !== 'connected') { msg.textContent = 'Home Assistant ' + ctx.ha.status; return; }
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
        overlay.innerHTML = `<img src="${img.src}" alt="">`;
        overlay._edgeTap = () => overlay.remove();
        document.body.appendChild(overlay);
        const t = setInterval(() => {
          if (!overlay.isConnected) return clearInterval(t);
          overlay.querySelector('img').src = img.src;
        }, 1000);
      };

      const unsub = ctx.ha.subscribe((id) => { if (id === '*' || id === s.entity) refresh(); });
      refresh();
      const timer = setInterval(refresh, Math.max(1, Number(s.refresh) || 5) * 1000);
      return { destroy() { clearInterval(timer); unsub(); } };
    },
  };

  // ---------------- Label / spacer ----------------
  const label = {
    name: 'Text label',
    size: [2, 1],
    props: [
      { key: 'text', label: 'Text', type: 'text' },
      { key: 'align', label: 'Align', type: 'select', default: 'left', options: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']] },
      { key: 'transparent', label: 'No background', type: 'bool', default: true },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s) {
      el.textContent = s.text || '';
      el.style.textAlign = s.align || 'left';
      el.classList.toggle('transparent', s.transparent !== false);
    },
  };

  window.Widgets = { key, media, 'ha-entity': haEntity, 'ha-camera': haCamera, clock, label };
})();
