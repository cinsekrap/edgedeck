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
      if (!domain || !service) throw new Error('Choose what this key does in Home Assistant');
      const data = {};
      for (const [k, v] of Object.entries(s.actionData || {})) if (v !== '' && v != null) data[k] = v;
      return ctx.ha.callService(domain, service, s.actionEntity || undefined, data);
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

  const key = {
    name: 'Key',
    size: [1, 1],
    props: [
      { key: 'label', label: 'Label', type: 'text' },
      {
        key: 'actionType', label: 'When tapped', type: 'select', default: 'app',
        options: [['app', 'Open app'], ['shortcut', 'Run Shortcut'], ['keys', 'Keyboard shortcut'], ['url', 'Open URL'],
          ['media', 'Media / volume'], ['ha', 'Home Assistant'], ['shell', 'Shell command'], ['applescript', 'AppleScript'], ['jxa', 'JavaScript (JXA)'], ['teams', 'Meeting control (Teams / Zoom)'], ['page', 'Go to page'], ['profile', 'Switch profile'], ['none', 'Nothing']],
      },
      { key: 'actionTarget', label: 'App', type: 'app', showIf: (w) => w.actionType === 'app' },
      { key: 'actionTarget', label: 'Shortcut name', type: 'shortcut', showIf: (w) => w.actionType === 'shortcut' },
      { key: 'actionTarget', label: 'Keys', type: 'text', placeholder: 'cmd+shift+4', hint: 'Modifiers: cmd, shift, alt, ctrl, fn. Keys: a–z, 0–9, f1–f20, space, return, tab, esc, up/down/left/right.', showIf: (w) => w.actionType === 'keys' },
      { key: 'actionTarget', label: 'URL', type: 'text', placeholder: 'https://…', showIf: (w) => w.actionType === 'url' },
      { key: 'actionTarget', label: 'Media action', type: 'select', options: [['playpause', 'Play / pause'], ['next', 'Next track'], ['previous', 'Previous track'], ['mute', 'Mute / unmute'], ['volup', 'Volume up'], ['voldown', 'Volume down'], ['micmute', 'Mute / unmute microphone']], showIf: (w) => w.actionType === 'media' },
      { key: 'actionEntity', label: 'Entity', type: 'entity', showIf: (w) => w.actionType === 'ha' },
      { key: 'actionTarget', label: 'Action', type: 'haservice', entityKey: 'actionEntity', dataKey: 'actionData', showIf: (w) => w.actionType === 'ha' },
      { key: 'actionTarget', label: 'Command', type: 'textarea', placeholder: 'open ~/Downloads', hint: 'Runs in zsh as you.', showIf: (w) => w.actionType === 'shell' },
      { key: 'actionTarget', label: 'Script', type: 'textarea', placeholder: 'tell application "Music" to playpause', hint: 'Runs through osascript. The first run may ask to allow EdgeDeck to control the app.', showIf: (w) => w.actionType === 'applescript' || w.actionType === 'jxa' },
      { key: 'actionTarget', label: 'Meeting action', type: 'select', options: [['toggle-mute', 'Mute / unmute'], ['toggle-video', 'Camera on / off'], ['toggle-hand', 'Raise / lower hand'], ['toggle-background-blur', 'Background blur'], ['leave-call', 'Leave meeting'], ['stop-sharing', 'Stop sharing'], ['toggle-ui:chat', 'Show / hide chat'], ['send-reaction:like', 'React 👍'], ['send-reaction:love', 'React ❤️'], ['send-reaction:applause', 'React 👏'], ['send-reaction:laugh', 'React 😂'], ['send-reaction:wow', 'React 😮']], showIf: (w) => w.actionType === 'teams' },
      {
        key: 'actionTarget', label: 'Profile', type: 'dynamic', showIf: (w) => w.actionType === 'profile',
        load: async () => ((window.EdgeDeck && EdgeDeck.State.config && EdgeDeck.State.config.profiles) || []).map((p) => [p.name, p.name]),
      },
      { key: 'actionTarget', label: 'Page (name or number)', type: 'page', showIf: (w) => w.actionType === 'page' },
      { key: 'iconType', label: 'Icon', type: 'select', default: 'auto', options: [['auto', 'Automatic'], ['emoji', 'Emoji or text'], ['image', 'Image URL'], ['none', 'None']] },
      { key: 'icon', label: 'Emoji / text', type: 'text', placeholder: '🎬', hint: 'Or a Material Design icon, e.g. mdi:lightbulb.', showIf: (w) => w.iconType === 'emoji' },
      { key: 'icon', label: 'Image URL', type: 'text', placeholder: 'https://…/icon.png', showIf: (w) => w.iconType === 'image' },
      { key: 'stateEntity', label: 'Light up when this entity is on', type: 'entity', hint: 'For a Home Assistant key, leave empty to follow the entity it controls.' },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.classList.add('pressable');
      el.innerHTML = '<div class="key-icon"></div><div class="key-label"></div>';
      const iconEl = el.querySelector('.key-icon');
      el.querySelector('.key-label').textContent = s.label || '';
      el.classList.toggle('no-label', !s.label);

      const iconType = s.iconType || 'auto';
      const haEntity = s.actionType === 'ha' ? s.actionEntity : '';
      if (iconType === 'emoji' && s.icon) {
        ctx.ha.setIcon(iconEl, null, s.icon);
        iconEl.classList.add('emoji');
      } else if (iconType === 'image' && s.icon) {
        iconEl.innerHTML = `<img src="${esc(s.icon)}" alt="">`;
      } else if (iconType === 'auto' && s.actionType === 'app' && s.actionTarget) {
        ctx.bridge.call('app.icon', { target: s.actionTarget }).then((url) => {
          if (url) iconEl.innerHTML = `<img src="${url}" alt="">`;
          else { iconEl.textContent = (s.label || '?').slice(0, 1); iconEl.classList.add('letter'); }
        }).catch(() => {});
      } else if (iconType === 'auto' && haEntity) {
        ctx.ha.setIcon(iconEl, haEntity);   // refreshed below once Home Assistant's icons arrive
        iconEl.classList.add('emoji');
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
      const stateId = s.stateEntity || haEntity;
      if (stateId) {
        const update = (id) => {
          if (id !== '*' && id !== stateId) return;
          const st = ctx.ha.states[stateId];
          el.classList.toggle('on', !!st && ctx.ha.ON_STATES.has(st.state));
          if (iconType === 'auto' && haEntity) ctx.ha.setIcon(iconEl, haEntity);
        };
        unsub = ctx.ha.subscribe(update);
        update('*');
      }
      return { destroy() { unsub && unsub(); } };
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

  window.Widgets = { key, media, clock, label };
  window.WidgetKit = { makeSlider, throttle, esc };
})();
