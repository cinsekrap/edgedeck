// First-run setup: a step-by-step window on the main screen, with matching
// progress shown on the Edge. Every step can be skipped; the step reached is
// saved so setup carries on after EdgeDeck restarts (needed for Input Monitoring).
(function () {
  const h = (...a) => window.EditorForm.h(...a);
  const STEPS = [
    ['welcome', 'Welcome'],
    ['connect', 'Connect the Edge'],
    ['touch', 'Allow touch'],
    ['calibrate', 'Line up touch'],
    ['features', 'Choose what you use'],
    ['layout', 'Pick a starting layout'],
    ['done', 'All set'],
  ];
  // [key, name, what it gives you, bundle IDs that suggest you use it]
  const FEATURES = [
    ['meetings', 'Teams and Zoom meetings', 'A meeting page with mute, camera, reactions, blur and leave appears on the Edge during calls.', ['com.microsoft.teams2', 'us.zoom.xos']],
    ['calendar', 'Calendar', 'Your upcoming events, with Join buttons for online meetings.', []],
    ['omnifocus', 'OmniFocus', 'Any of your perspectives, exactly as in OmniFocus; tick tasks off and set planned dates.', ['com.omnigroup.OmniFocus4', 'com.omnigroup.OmniFocus3']],
    ['media', 'Spotify or Music', 'What’s playing, with play/pause, skip and volume.', ['com.spotify.client']],
    ['badges', 'Unread counts', 'The red badge counts from Outlook, Teams, WhatsApp and other apps in your Dock.', ['com.microsoft.Outlook', 'net.whatsapp.WhatsApp']],
    ['lights', 'Elgato Key Lights', 'Power, brightness and colour; optionally on automatically during meetings.', []],
    ['homeassistant', 'Home Assistant', 'Lights, switches and cameras from your Home Assistant.', []],
  ];

  const S = { cfg: null, firstRun: true, step: 0, features: new Set(['calendar', 'media']), template: 'work', cleanups: [], lightsFound: 0 };

  // replaceChildren() would print null/false as text; drop empty slots first.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const card = (...kids) => h('section', { class: 'st-card' }, ...kids);
  const note = (text) => h('p', { class: 'st-note' }, text);
  const statusLine = (ok, text) => h('div', { class: 'st-status ' + (ok === true ? 'ok' : ok === false ? 'bad' : '') }, text);
  function every(ms, fn) {
    fn();
    const t = setInterval(fn, ms);
    S.cleanups.push(() => clearInterval(t));
  }
  const touchWorking = (s) => /connected/i.test(s.touch) && !/dis|without exclusive|could not/i.test(s.touch);

  // ---------- Steps ----------
  const steps = {
    welcome() {
      return [
        h('p', { class: 'su-lead' }, 'EdgeDeck turns your Corsair Xeneon Edge into a touch dashboard for your Mac: keys, now playing, calendar, meetings, tasks, lights and more.'),
        h('p', {}, 'This takes a couple of minutes. Every step can be skipped and you can come back any time from the menu bar → Set Up EdgeDeck….'),
      ];
    },

    connect() {
      const box = h('div');
      every(2000, () => EdgeBridge.call('status').then((s) => {
        fill(box, 
          statusLine(s.screenFound, s.screenFound ? '✓ The Edge’s display is connected' : '✗ The Edge’s display wasn’t found'),
          statusLine(/connected/i.test(s.touch) && !/dis/i.test(s.touch), /connected/i.test(s.touch) && !/dis/i.test(s.touch) ? '✓ Its touch controller is connected' : '✗ Its touch controller wasn’t found'),
          s.screenFound && /connected/i.test(s.touch) ? null : note('The picture and touch travel separately. A single USB-C cable carries both; if you use HDMI or DisplayPort for the picture, also connect the Edge’s USB-C cable to your Mac. Checking every couple of seconds…'));
      }).catch(() => {}));
      return [h('p', {}, 'Plug in the Edge. These update by themselves:'), card(box)];
    },

    touch() {
      const box = h('div');
      let restarting = false;
      every(1500, () => EdgeBridge.call('status').then((s) => {
        if (restarting) return;
        if (touchWorking(s)) {
          fill(box, statusLine(true, '✓ Touch is working — touching the Edge won’t move your cursor.'));
          return;
        }
        if (s.inputMonitoring) {
          // Allowed. It only takes effect for a fresh launch, so restart — but only when the
          // touch controller is there and couldn't be taken over (a restart can't fix a missing
          // Edge), and automatically at most once every 2 minutes (no restart loops).
          const needsRestart = /without exclusive|could not open/i.test(s.touch);
          if (!needsRestart) {
            fill(box, statusLine(true, '✓ Allowed'), note('Connect the Edge to check touch works — or continue and check later.'));
            return;
          }
          let last = 0;
          try { last = Number(localStorage.getItem('edgedeck.setupRestart') || 0); } catch (e) {}
          const restart = () => {
            restarting = true;
            try { localStorage.setItem('edgedeck.setupRestart', String(Date.now())); } catch (e) {}
            fill(box, statusLine(true, '✓ Allowed. Restarting EdgeDeck so it takes effect…'));
            EdgeBridge.call('setup.state', { step: S.step }).then(() => setTimeout(() => EdgeBridge.call('app.relaunch'), 1200));
          };
          if (Date.now() - last > 120000) { restart(); return; }
          fill(box, statusLine(true, '✓ Allowed'),
            note('Touch still isn’t taking over. Try restarting EdgeDeck; if that doesn’t help, turn EdgeDeck off and on again under Input Monitoring.'),
            h('div', { class: 'ed-row' }, h('button', { class: 'ed-btn primary', onclick: restart }, 'Restart EdgeDeck')));
          return;
        }
        fill(box, 
          statusLine(false, 'Not allowed yet'),
          h('div', { class: 'ed-row' }, h('button', { class: 'ed-btn primary', onclick: () => EdgeBridge.call('permissions.open', { which: 'inputMonitoring' }) }, 'Open System Settings')),
          note('In Privacy & Security → Input Monitoring, turn on EdgeDeck. EdgeDeck then restarts by itself and comes back to this step.'));
      }).catch(() => {}));
      return [
        h('p', {}, 'To read touches from the Edge — and stop them moving your Mac’s cursor — macOS needs you to allow EdgeDeck under Input Monitoring.'),
        card(box),
      ];
    },

    calibrate() {
      const box = h('div');
      every(2000, () => EdgeBridge.call('config.get').then((r) => {
        const cfg = r && r.config ? JSON.parse(r.config) : {};
        const done = Array.isArray(cfg.device && cfg.device.calibration);
        fill(box, statusLine(done || null, done ? '✓ Calibrated' : 'Not calibrated yet'));
      }).catch(() => {}));
      return [
        h('p', {}, 'Optional, but recommended: five targets appear on the Edge; touch the middle of each, then check the dot follows your finger and tap Save.'),
        card(h('div', { class: 'ed-row' },
          h('button', { class: 'ed-btn primary', onclick: () => EdgeBridge.call('touch.calibrate').catch((e) => EdgeDeck.toast(e.message, 'error')) }, 'Calibrate on the Edge')), box),
      ];
    },

    features() {
      const list = h('div', { class: 'su-features' });
      const extras = {
        meetings: () => permissionRow('accessibility', 'Needs Accessibility, to read and press the meeting buttons.'),
        badges: () => permissionRow('accessibility', 'Needs Accessibility, to read the Dock’s badges.'),
        calendar: () => {
          const st = h('span', { class: 'st-status' });
          every(3000, () => EdgeBridge.call('status').then((s) => {
            st.className = 'st-status ' + (s.calendar === 'granted' ? 'ok' : '');
            st.textContent = s.calendar === 'granted' ? '✓ Calendar access allowed' : 'Calendar access not allowed yet';
          }).catch(() => {}));
          return h('div', { class: 'su-extra' }, st,
            h('button', { class: 'ed-btn small', onclick: () => EdgeBridge.call('calendar.events', { days: 1, limit: 1 }).catch(() => EdgeBridge.call('permissions.open', { which: 'calendars' })) }, 'Allow now'));
        },
        lights: () => {
          const st = h('span', { class: 'st-status' }, 'Looking for lights on your network…');
          every(2000, () => EdgeBridge.call('elgato.list').then((l) => {
            S.lightsFound = l.length;
            st.className = 'st-status ' + (l.length ? 'ok' : '');
            st.textContent = l.length ? `✓ Found ${l.length} light${l.length > 1 ? 's' : ''}` : 'Looking for lights on your network… (macOS may ask about Local Network access — allow it)';
          }).catch(() => {}));
          const auto = h('input', { type: 'checkbox' });
          auto.checked = S.lightsInMeetings !== false;
          auto.addEventListener('change', () => (S.lightsInMeetings = auto.checked));
          return h('div', { class: 'su-extra' }, st, h('label', { class: 'ed-check' }, auto, h('span', {}, 'Turn them on during meetings')));
        },
        omnifocus: () => h('div', { class: 'su-extra' },
          note('macOS will ask to let EdgeDeck control OmniFocus the first time a perspective loads. OmniFocus needs to be open.')),
        media: () => h('div', { class: 'su-extra' }, note('macOS asks to let EdgeDeck control Spotify or Music the first time it reads what’s playing.')),
        homeassistant: () => {
          const ha = S.cfg.homeAssistant;
          const url = h('input', { type: 'text', placeholder: 'http://homeassistant.local:8123' });
          url.value = ha.url || '';
          url.addEventListener('input', () => (ha.url = url.value.trim()));
          const token = h('input', { type: 'password', placeholder: 'Long-lived access token' });
          token.value = ha.token || '';
          token.addEventListener('input', () => (ha.token = token.value.trim()));
          return h('div', { class: 'su-extra su-ha' }, url, token, note('Home Assistant → your profile → Security → Long-lived access tokens → Create token.'));
        },
      };
      function render() {
        S.cleanups.splice(0).forEach((f) => f());
        fill(list, ...FEATURES.map(([key, name, what]) => {
          const on = S.features.has(key);
          const c = h('input', { type: 'checkbox' });
          c.checked = on;
          c.addEventListener('change', () => { if (c.checked) S.features.add(key); else S.features.delete(key); render(); });
          return h('div', { class: 'su-feature' + (on ? ' on' : '') },
            h('label', { class: 'su-feature-head' }, c, h('span', { class: 'su-feature-name' }, name)),
            h('div', { class: 'st-note' }, what),
            on && extras[key] ? extras[key]() : null);
        }));
      }
      render();
      return [h('p', {}, 'Tick what you use. Anything that needs a permission says so, and you can allow it here or later.'), list];
    },

    layout() {
      const has = (f) => S.features.has(f);
      const describe = {
        work: ['Work desk', [has('omnifocus') && 'OmniFocus', has('calendar') && 'calendar', has('media') && 'now playing', 'clock', has('lights') && 'Key Lights', has('badges') && 'unread counts', 'system stats', has('homeassistant') && 'a Home page'].filter(Boolean).join(', ')],
        minimal: ['Minimal', ['clock', has('media') ? 'now playing' : 'weather', 'four app keys', has('lights') && 'Key Lights', has('calendar') && 'calendar'].filter(Boolean).join(', ')],
        blank: ['Blank', 'An empty page to build your own.'],
      };
      const box = h('div', { class: 'su-layouts' });
      const render = () => fill(box, ...Object.entries(describe).map(([k, [name, what]]) =>
        h('button', { class: 'su-layout' + (S.template === k ? ' on' : ''), onclick: () => { S.template = k; render(); } },
          h('div', { class: 'su-layout-name' }, name), h('div', { class: 'st-note' }, what))));
      render();
      const existing = !S.firstRun && S.cfg.profiles.some((p) => p.pages.some((pg) => pg.widgets.length));
      return [
        h('p', {}, 'You can change everything afterwards in the editor.' + (has('meetings') ? ' The meeting page is set up separately and appears during calls.' : '')),
        box,
        existing ? note('You already have a layout, so this one is added as a new profile — your current pages are kept.') : null,
      ];
    },

    done() {
      return [
        h('p', { class: 'su-lead' }, 'EdgeDeck is ready.'),
        h('ul', { class: 'su-tips' },
          h('li', {}, 'Swipe left and right on the Edge to change page.'),
          h('li', {}, 'Menu bar → Edit Dashboard… to add, move and resize widgets. Profiles live at its top left.'),
          h('li', {}, 'Menu bar → Settings… for text size, the screen saver, touch, meetings and permissions.'),
          S.features.has('meetings') ? h('li', {}, 'During a Teams or Zoom call, the meeting page appears on the Edge by itself.') : null,
          S.features.has('omnifocus') ? h('li', {}, 'Pick which OmniFocus perspective to show in the editor (click the OmniFocus widget).') : null),
      ];
    },
  };

  function permissionRow(which, text) {
    const st = h('span', { class: 'st-status' });
    every(2000, () => EdgeBridge.call('status').then((s) => {
      const ok = which === 'accessibility' ? s.accessibility : s.inputMonitoring;
      st.className = 'st-status ' + (ok ? 'ok' : '');
      st.textContent = ok ? '✓ Allowed' : text;
    }).catch(() => {}));
    return h('div', { class: 'su-extra' }, st, h('button', { class: 'ed-btn small', onclick: () => EdgeBridge.call('permissions.open', { which }) }, 'Allow'));
  }

  // ---------- Applying the choices ----------
  async function apply() {
    const f = S.features;
    const cfg = S.cfg;
    const teams = Object.assign({}, cfg.teams, { enabled: f.has('meetings'), autoPage: f.has('meetings'), lightsOn: f.has('meetings') && f.has('lights') && S.lightsInMeetings !== false });
    const profile = EdgeDeck.buildTemplate(S.template, [...f]);
    let profiles = cfg.profiles;
    // First run: replace the starter layout. Running setup again: keep what you've built.
    const existing = !S.firstRun && profiles.some((p) => p.pages.some((pg) => pg.widgets.length));
    if (existing) {
      let name = profile.name, i = 2;
      while (profiles.some((p) => p.name === name)) name = `${profile.name} ${i++}`;
      profile.name = name;
      profiles = [...profiles, profile];
    } else {
      profiles = [profile];
    }
    await EdgeBridge.call('config.update', { section: '*', json: JSON.stringify({ profiles, activeProfile: profile.id, teams, homeAssistant: cfg.homeAssistant }) });
  }

  // ---------- Layout ----------
  function render() {
    S.cleanups.splice(0).forEach((f) => f());
    const [key, title] = STEPS[S.step];
    fill(document.querySelector('.su-steps'), ...STEPS.map(([k, t], i) =>
      h('div', { class: 'su-step' + (i < S.step ? ' done' : i === S.step ? ' now' : '') }, h('span', { class: 'su-num' }, i < S.step ? '✓' : String(i + 1)), t)));
    document.querySelector('.su-title').textContent = title;
    fill(document.querySelector('.su-body'), ...steps[key]().filter(Boolean));
    const last = S.step === STEPS.length - 1;
    fill(document.querySelector('.su-buttons'), 
      S.step > 0 && !last ? h('button', { class: 'ed-btn', onclick: () => go(S.step - 1) }, 'Back') : h('span'),
      h('span', { class: 'ed-spacer' }),
      !last && key !== 'welcome' && key !== 'layout' ? h('button', { class: 'ed-btn', onclick: () => go(S.step + 1) }, 'Skip') : null,
      last
        ? h('div', { class: 'ed-row' },
            h('button', { class: 'ed-btn', onclick: () => finish(true) }, 'Open the editor'),
            h('button', { class: 'ed-btn primary', onclick: () => finish(false) }, 'Finish'))
        : h('button', { class: 'ed-btn primary', onclick: next }, key === 'welcome' ? 'Get started' : key === 'layout' ? 'Use this layout' : 'Continue'));
    EdgeBridge.call('setup.progress', { progress: { step: S.step, total: STEPS.length, title } }).catch(() => {});
    EdgeBridge.call('setup.state', { step: S.step }).catch(() => {});
  }

  async function next() {
    if (STEPS[S.step][0] === 'layout') {
      try { await apply(); } catch (e) { EdgeDeck.toast('Couldn’t save the layout: ' + e.message, 'error'); return; }
    }
    go(S.step + 1);
  }
  function go(i) {
    S.step = Math.max(0, Math.min(STEPS.length - 1, i));
    render();
  }
  async function finish(openEditor) {
    if (openEditor) await EdgeBridge.call('editor.open').catch(() => {});
    await EdgeBridge.call('setup.done').catch(() => {});
  }

  window.Setup = {
    async start(cfg) {
      S.cfg = cfg;
      EdgeDeck.applyTheme(cfg);
      document.body.classList.add('editing', 'settings', 'setup');
      const app = document.getElementById('app');
      app.className = 'st-app su-app';
      fill(app, 
        h('nav', { class: 'st-nav su-steps' }),
        h('main', { class: 'st-main' },
          h('header', { class: 'st-head' }, h('h1', { class: 'su-title' })),
          h('div', { class: 'st-body su-body' }),
          h('footer', { class: 'su-buttons' })));
      // Pre-tick what this Mac suggests you use.
      try {
        const ids = FEATURES.flatMap(([, , , i]) => i);
        const installed = new Set(await EdgeBridge.call('apps.installed', { ids }));
        for (const [key, , , i] of FEATURES) if (i.some((id) => installed.has(id))) S.features.add(key);
      } catch (e) { /* preview */ }
      try {
        const st = await EdgeBridge.call('setup.state');
        S.firstRun = !(st && st.done);
        if (st && st.step > 0 && !st.done) S.step = Math.min(st.step, STEPS.length - 1);
      } catch (e) { /* preview */ }
      render();
    },
  };
})();
