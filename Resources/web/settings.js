// Settings window: a sidebar of sections; every change saves straight away
// (just that part of the config) and applies to the Edge. The editor only
// saves pages, so the two windows never overwrite each other.
(function () {
  const S = { cfg: null, section: 'general', timers: {}, cleanups: [] };
  const SECTIONS = [
    ['general', 'General', '⚙️'],
    ['appearance', 'Appearance', '🎨'],
    ['touch', 'Touch', '👆'],
    ['screensaver', 'Screen saver', '🌙'],
    ['teams', 'Meetings', '👥'],
    ['homeassistant', 'Home Assistant', '🏠'],
    ['permissions', 'Permissions', '🔒'],
    ['updates', 'Updates', '⬇️'],
  ];
  const h = (...a) => window.EditorForm.h(...a);
  const control = (prop, obj, section) => window.EditorForm.control(prop, obj, () => save(section));
  const card = (title, ...kids) => h('section', { class: 'st-card' }, title ? h('h3', {}, title) : null, h('div', { class: 'ed-form' }, kids));
  const note = (text) => h('p', { class: 'st-note' }, text);

  // ---------- Saving ----------
  function save(section) {
    clearTimeout(S.timers[section]);
    status('Saving…');
    S.timers[section] = setTimeout(async () => {
      delete S.timers[section];
      try {
        await EdgeBridge.call('config.update', { section, json: JSON.stringify(S.cfg[section]) });
        status('Saved ✓');
      } catch (e) {
        status('');
        EdgeDeck.toast('Couldn’t save: ' + e.message, 'error');
      }
    }, 400);
  }
  let statusTimer;
  function status(text) {
    const el = document.querySelector('.st-saved');
    if (!el) return;
    el.textContent = text;
    clearTimeout(statusTimer);
    if (text.startsWith('Saved')) statusTimer = setTimeout(() => (el.textContent = ''), 2000);
  }

  // Re-check something every few seconds while its section is showing.
  function every(ms, fn) {
    fn();
    const t = setInterval(fn, ms);
    S.cleanups.push(() => clearInterval(t));
  }
  const statusLine = (ok, text) => h('div', { class: 'st-status ' + (ok === true ? 'ok' : ok === false ? 'bad' : '') }, text);

  // ---------- Sections ----------
  const build = {
    general(cfg) {
      const login = h('div', {}, 'Checking…');
      EdgeBridge.call('login.get').then((l) => {
        login.innerHTML = '';
        if (!l.supported) { login.append(note('Start at login needs macOS 13 or later.')); return; }
        const c = h('input', { type: 'checkbox' });
        c.checked = !!l.enabled;
        c.addEventListener('change', () => EdgeBridge.call('login.set', { enabled: c.checked })
          .then((on) => { c.checked = !!on; status('Saved ✓'); })
          .catch((e) => { c.checked = !c.checked; EdgeDeck.toast(e.message, 'error'); }));
        login.append(h('label', { class: 'ed-check' }, c, h('span', {}, 'Start EdgeDeck when you log in')));
      }).catch(() => (login.textContent = 'Unavailable'));

      const display = h('div');
      every(3000, () => EdgeBridge.call('status').then((s) => {
        display.replaceChildren(
          statusLine(s.screenFound, s.screenFound ? '✓ Xeneon Edge found' : '✗ Xeneon Edge not found'),
          statusLine(/connected/i.test(s.touch) && !/dis/i.test(s.touch), 'Touch: ' + s.touch));
      }).catch(() => {}));

      return [
        card('Startup', login),
        card('Display', display,
          control({ key: 'fixStretch', label: 'Correct for a stretched 16:9 signal', type: 'bool', default: true,
            hint: 'macOS drives the Edge at 1920×1080 and the panel stretches it. This lays the dashboard out at 2560×720 and pre-squashes it so it looks right. Turn off if the Edge runs at 2560×720.' }, cfg.device, 'device'),
          control({ key: 'screenName', label: 'Display name contains', type: 'text', placeholder: 'XENEON', hint: 'Leave blank to find the Edge automatically.' }, cfg.device, 'device')),
        card('Dashboard',
          h('div', { class: 'ed-row' },
            h('button', { class: 'ed-btn', onclick: () => EdgeBridge.call('editor.open') }, 'Edit dashboard…'),
            h('button', { class: 'ed-btn', onclick: () => EdgeBridge.call('config.reveal') }, 'Show config file in Finder'))),
      ];
    },

    appearance(cfg) {
      return [
        card('Text',
          control({ key: 'textScale', label: 'Text size', type: 'select', default: '100',
            options: [['90', 'Smaller (90%)'], ['100', 'Standard (100%)'], ['115', 'Larger (115%)'], ['130', 'Large (130%)'], ['150', 'Largest (150%)']],
            hint: 'Scales the text in every widget; icons and tiles stay the same size. The Edge’s stretched picture makes small text look soft, so Larger or Large usually reads best.' }, cfg.theme, 'theme')),
        card('Colours',
          control({ key: 'accent', label: 'Accent colour', type: 'color' }, cfg.theme, 'theme'),
          control({ key: 'background', label: 'Background', type: 'color' }, cfg.theme, 'theme'),
          control({ key: 'tile', label: 'Tile colour', type: 'color' }, cfg.theme, 'theme'),
          control({ key: 'radius', label: 'Corner radius (px)', type: 'number', min: 0, max: 60 }, cfg.theme, 'theme')),
        card('Grid', note('Each profile has its own grid, and so does the meeting page: set them in the editor, under the page’s settings.')),
      ];
    },

    touch(cfg) {
      const calibrated = Array.isArray(cfg.device.calibration);
      const touchStatus = h('div');
      every(3000, () => EdgeBridge.call('status').then((s) => {
        touchStatus.replaceChildren(statusLine(/connected/i.test(s.touch) && !/dis/i.test(s.touch), 'Touch: ' + s.touch));
      }).catch(() => {}));
      return [
        card('Calibration',
          statusLine(calibrated || null, calibrated ? '✓ Calibrated' : 'Not calibrated (using the raw touch position)'),
          h('div', { class: 'ed-row' },
            h('button', { class: 'ed-btn primary', onclick: () => EdgeBridge.call('touch.calibrate').then(() => EdgeDeck.toast('Follow the targets on the Edge')).catch((e) => EdgeDeck.toast(e.message, 'error')) }, 'Calibrate on the Edge…'),
            calibrated ? h('button', { class: 'ed-btn', onclick: () => EdgeBridge.call('touch.calibrate', { reset: true }).catch((e) => EdgeDeck.toast(e.message, 'error')) }, 'Reset') : null),
          note('Shows five targets on the Edge to touch, then a check screen. Calibrate again if you change the orientation settings below.')),
        card('Orientation',
          control({ key: 'flipX', label: 'Flip horizontally', type: 'bool' }, cfg.device, 'device'),
          control({ key: 'flipY', label: 'Flip vertically', type: 'bool' }, cfg.device, 'device'),
          control({ key: 'swapXY', label: 'Swap X and Y (portrait mounting)', type: 'bool' }, cfg.device, 'device')),
        card('Checking',
          control({ key: 'showTouches', label: 'Show touch points on the Edge', type: 'bool' }, cfg.device, 'device'),
          touchStatus),
      ];
    },

    screensaver(cfg) {
      const ss = cfg.screensaver;
      return [
        card('Dim',
          control({ key: 'dimAfter', label: 'Dim after (minutes without a touch, 0 = never)', type: 'number', min: 0, max: 240 }, ss, 'screensaver'),
          control({ key: 'dimLevel', label: 'Dimmed brightness (%)', type: 'number', min: 0, max: 90, step: 5 }, ss, 'screensaver')),
        card('Blank',
          control({ key: 'blankAfter', label: 'Blank after (minutes without a touch, 0 = never)', type: 'number', min: 0, max: 480 }, ss, 'screensaver'),
          control({ key: 'blankClock', label: 'Show a small drifting clock while blank', type: 'bool' }, ss, 'screensaver')),
        card('Schedule',
          control({ key: 'schedule', label: 'Blank on a schedule', type: 'bool' }, ss, 'screensaver'),
          control({ key: 'scheduleFrom', label: 'Blank from', type: 'text', placeholder: '23:00' }, ss, 'screensaver'),
          control({ key: 'scheduleTo', label: 'Until', type: 'text', placeholder: '07:00' }, ss, 'screensaver'),
          note('24-hour times. Inside this window the Edge blanks a minute after the last touch.')),
        card('Protecting the panel',
          control({ key: 'pixelShift', label: 'Shift the layout by a few pixels every 3 minutes', type: 'bool' }, ss, 'screensaver'),
          note('The first touch after dimming or blanking only wakes the screen. Menu bar → Blank Edge Now blanks it until the next touch.')),
      ];
    },

    teams(cfg) {
      const live = h('div');
      every(3000, () => EdgeBridge.call('teams.state').then((t) => {
        live.replaceChildren(statusLine(t.connected ? true : t.reason === 'accessibility' ? false : null,
          t.connected ? '✓ Watching Teams and Zoom' + (t.meeting && t.meeting.isInMeeting ? ` — in a ${t.app || 'Teams'} meeting` : '')
            : t.reason === 'accessibility' ? '✗ Needs Accessibility permission (see Permissions)'
            : t.reason === 'not running' ? 'Teams isn’t open' : 'Off'));
      }).catch(() => (live.textContent = 'Status unavailable')));
      return [
        card('Teams and Zoom',
          control({ key: 'enabled', label: 'Watch Teams and Zoom for meetings and show their controls', type: 'bool' }, cfg.teams, 'teams'),
          live,
          note('Teams: reads its meeting buttons (mute, camera, raise hand, reactions, blur, stop sharing, leave). Zoom: uses its Meeting menu (mute, camera, chat, stop sharing) and its Leave button. Both need to be in English for the on/off states to read correctly.')),
        card('During meetings',
          control({ key: 'autoPage', label: 'Show the meeting page during meetings', type: 'bool',
            hint: 'Added to the Edge when a meeting starts and taken away when it ends, whichever profile you’re using. Arrange it in the editor’s 👥 Meeting tab.' }, cfg.teams, 'teams'),
          control({ key: 'stayAwake', label: 'Keep the Edge awake during meetings', type: 'bool' }, cfg.teams, 'teams'),
          control({ key: 'lightsOn', label: 'Turn my Elgato Key Lights on during meetings', type: 'bool',
            hint: 'Lights that were off are switched off again when the meeting ends.' }, cfg.teams, 'teams')),
      ];
    },

    homeassistant(cfg) {
      const st = h('div');
      const show = () => st.replaceChildren(statusLine(HA.status === 'connected' ? true : /failed|offline/.test(HA.status) ? false : null,
        'Status: ' + HA.status + (HA.status === 'connected' ? ` · ${Object.keys(HA.states).length} entities` : '')));
      show();
      S.cleanups.push(HA.subscribe(show));
      HA.configure(cfg.homeAssistant.url, cfg.homeAssistant.token);
      let t;
      const changed = () => { save('homeAssistant'); clearTimeout(t); t = setTimeout(() => HA.configure(cfg.homeAssistant.url, cfg.homeAssistant.token), 800); };
      const field = (prop) => window.EditorForm.control(prop, cfg.homeAssistant, changed);
      return [
        card('Connection',
          field({ key: 'url', label: 'URL', type: 'text', placeholder: 'http://homeassistant.local:8123' }),
          field({ key: 'token', label: 'Long-lived access token', type: 'password', hint: 'Home Assistant → your profile → Security → Long-lived access tokens → Create token.' }),
          st),
      ];
    },

    permissions() {
      const box = h('div', { class: 'st-perms' });
      const row = (name, why, ok, which, extra) => h('div', { class: 'st-perm' },
        h('div', { class: 'st-perm-text' }, h('div', { class: 'st-perm-name' }, name), h('div', { class: 'st-note' }, why)),
        statusLine(ok, ok === true ? '✓ Allowed' : ok === false ? '✗ Not allowed' : extra || 'Asked when first needed'),
        h('button', { class: 'ed-btn', onclick: () => EdgeBridge.call('permissions.open', { which }) }, 'Open System Settings'));
      every(3000, () => EdgeBridge.call('status').then((s) => {
        box.replaceChildren(
          row('Input Monitoring', 'Reads the touch controller and stops it moving your cursor. After allowing it, quit and reopen EdgeDeck.', !!s.inputMonitoring, 'inputMonitoring'),
          row('Accessibility', 'Keyboard-shortcut keys, and reading/pressing Teams’ meeting buttons.', !!s.accessibility, 'accessibility'),
          row('Calendars', 'The Calendar widget.', s.calendar === 'granted' ? true : s.calendar === 'not asked' ? null : false, 'calendars'),
          row('Automation', 'Spotify, Music, OmniFocus and Script widgets. macOS asks the first time for each app; manage them here.', null, 'automation', 'Per app'));
      }).catch(() => (box.textContent = 'Status unavailable')));
      return [card(null, box)];
    },

    updates(cfg) {
      cfg.updates = cfg.updates || { autoCheck: true };
      const box = h('div', { class: 'st-wide' });
      let busy = '';
      const when = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const draw = (u) => {
        if (!u) return;
        const lines = [statusLine(null, 'You have EdgeDeck ' + u.current + '.')];
        if (u.installing || busy === 'install') lines.push(statusLine(null, 'Downloading and checking ' + (u.latest || 'the update') + '… EdgeDeck restarts when it’s done.'));
        else if (u.checking || busy === 'check') lines.push(statusLine(null, 'Checking…'));
        else if (u.error) lines.push(statusLine(false, '✗ ' + u.error));
        else if (u.available) lines.push(statusLine(true, 'EdgeDeck ' + u.latest + ' is available.'));
        else if (u.latest) lines.push(statusLine(true, '✓ Up to date' + (u.checked ? ' (checked ' + when(u.checked) + ')' : '')));
        const buttons = [
          h('button', { class: 'ed-btn', disabled: u.checking || u.installing || null, onclick: () => {
            busy = 'check'; draw(u);
            EdgeBridge.call('updates.check').then((s) => { busy = ''; draw(s); }).catch((e) => { busy = ''; EdgeDeck.toast(e.message, 'error'); });
          } }, 'Check now'),
        ];
        if (u.available && u.canInstall) buttons.unshift(h('button', { class: 'ed-btn primary', disabled: u.installing || null, onclick: () => {
          busy = 'install'; draw(u);
          EdgeBridge.call('updates.install').catch((e) => { busy = ''; EdgeDeck.toast('Not installed: ' + e.message, 'error'); EdgeBridge.call('updates.state').then(draw); });
        } }, 'Install ' + u.latest + ' and restart'));
        if (u.latest) buttons.push(h('button', { class: 'ed-btn', onclick: () => EdgeBridge.call('updates.page') }, 'Release page'));
        box.replaceChildren(...[...lines, h('div', { class: 'ed-row' }, ...buttons),
          u.available && u.notes ? h('pre', { class: 'st-notes' }, u.notes) : null,
          u.available && !u.canInstall ? note('This copy can’t update itself (it isn’t signed with a Developer ID, or can’t write to its folder). Download the new version from the release page.') : null,
        ].filter(Boolean));   // replaceChildren would print a null as text
      };
      S.updatesChanged = draw;
      S.cleanups.push(() => (S.updatesChanged = null));
      EdgeBridge.call('updates.state').then(draw).catch(() => (box.textContent = 'Unavailable'));
      return [
        card(null, box),
        card('Automatic checks',
          control({ key: 'autoCheck', label: 'Check for updates automatically', type: 'bool', default: true }, cfg.updates, 'updates'),
          note('Once a day, EdgeDeck asks GitHub for the latest release. Nothing is installed until you choose to. Before installing, it checks that the download matches the published SHA-256, is signed by the same developer and is notarised by Apple.')),
      ];
    },
  };

  // ---------- Layout ----------
  function render() {
    S.cleanups.forEach((f) => { try { f(); } catch (e) {} });
    S.cleanups = [];
    window.EditorForm.useConfig(S.cfg);
    const [, title] = SECTIONS.find(([k]) => k === S.section);
    const nav = document.querySelector('.st-nav');
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === S.section));
    document.querySelector('.st-title').textContent = title;
    const body = document.querySelector('.st-body');
    body.replaceChildren(...build[S.section](S.cfg).filter((k) => k != null && k !== false));
    body.scrollTop = 0;
  }

  window.Settings = {
    start(cfg) {
      S.cfg = cfg;
      const wanted = new URLSearchParams(location.search).get('section');
      if (wanted && SECTIONS.some(([k]) => k === wanted)) S.section = wanted;
      EdgeDeck.applyTheme(cfg);
      document.body.classList.add('editing', 'settings');
      const app = document.getElementById('app');
      app.className = 'st-app';
      app.replaceChildren(
        h('nav', { class: 'st-nav' }, SECTIONS.map(([k, label, icon]) =>
          h('button', { 'data-k': k, onclick: () => { S.section = k; render(); } }, h('span', { class: 'st-icon' }, icon), label))),
        h('main', { class: 'st-main' },
          h('header', { class: 'st-head' }, h('h1', { class: 'st-title' }), h('span', { class: 'st-saved' })),
          h('div', { class: 'st-body' })));
      render();
    },

    // The Mac's updater changed state (checking, found one, installing…).
    updatesChanged(state) { if (S.updatesChanged) S.updatesChanged(state); },

    // Another window (or the dashboard) saved: pick up changes made elsewhere,
    // but never redraw over a change of ours that hasn't been saved yet.
    sync(fresh) {
      if (!S.cfg || Object.keys(S.timers).length) return;
      if (JSON.stringify(fresh) === JSON.stringify(S.cfg)) return;
      S.cfg = fresh;
      render();
    },
  };
})();
