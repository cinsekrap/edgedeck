// Bridge to the Mac app. When opened in an ordinary browser (for previewing),
// a mock stands in so the dashboard and editor still work.
(function () {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.edge;
  const native = !!handler;
  const pending = new Map();
  let nextId = 0;

  // ---------- Mock for browser preview ----------
  const mockStart = Date.now();
  let mockPlaying = true;
  let mockVolume = 45;
  let mockMicMuted = false, mockInput = 1, mockOutput = 3;
  const mockLights = [{ id: 'Elgato Key Light MK 2 1A2B', name: 'Key Light 1A2B', on: false, brightness: 18, temperature: 275 },
    { id: 'Elgato Key Light MK 2 3C4D', name: 'Key Light 3C4D', on: false, brightness: 16, temperature: 271 }];
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const mockOmniFocus = [
    { k: 'g', n: 'EdgeDeck', d: 0 },
    { k: 't', id: 'a1', n: 'Write the OmniFocus widget', d: 1, f: true, pr: 'EdgeDeck', tags: ['Mac'], pl: +day0 + 14 * 3600e3, due: null },
    { k: 't', id: 'a2', n: 'Test on the real panel', d: 1, pr: 'EdgeDeck', tags: [], est: 90, pl: null, due: +day0 - 3600e3 },
    { k: 'g', n: 'Home', d: 0 },
    { k: 't', id: 'b1', n: 'Book the boiler service', d: 1, pr: 'Home', tags: ['Phone'], est: 15, pl: +day0 + 42 * 3600e3, due: +day0 + 5 * 86400e3 },
    { k: 't', id: 'b2', n: 'Renew the car insurance', d: 1, pr: 'Home', tags: [], pl: null, due: null },
    { k: 't', id: 'b4', n: 'Fix the shed door', d: 1, pr: 'Home', tags: [], pl: null, due: null, dr: true },
    { k: 't', id: 'b3', n: 'Sort out the loft', d: 1, pr: 'Home', tags: ['Weekend'], pl: null, due: null },
  ];
  const mockMeeting = {
    isInMeeting: /[?&]meeting/.test(location.search), isMuted: true, isVideoOn: false, isHandRaised: false, isRecordingOn: true,
    isBackgroundBlurred: false, isSharing: false, hasUnreadMessages: true,
    canToggleMute: true, canToggleVideo: true, canToggleHand: true, canToggleBlur: true, canLeave: true, canReact: true,
    canToggleChat: true, canStopSharing: false, canPair: false,
  };
  const Mock = {
    call(cmd, args) {
      switch (cmd) {
        case 'config.get':
          return { config: localStorage.getItem('edgedeck.config') };
        case 'config.save':
          localStorage.setItem('edgedeck.config', args.config);
          setTimeout(() => window.EdgeDeck && EdgeDeck.reloadConfig(), 0);
          return true;
        case 'media.state': {
          const pos = ((Date.now() - mockStart) / 1000) % 215;
          return {
            app: 'Spotify', state: mockPlaying ? 'playing' : 'paused',
            title: 'Midnight City', artist: 'M83', album: "Hurry Up, We're Dreaming",
            artwork: '', position: pos, duration: 243, volume: mockVolume,
          };
        }
        case 'media.control':
          if (args.action === 'playpause') mockPlaying = !mockPlaying;
          return true;
        case 'volume.set': mockVolume = args.value; return true;
        case 'apps.list':
          return [['App Store', 'com.apple.AppStore'], ['Calendar', 'com.apple.iCal'], ['Finder', 'com.apple.finder'],
            ['Mail', 'com.apple.mail'], ['Music', 'com.apple.Music'], ['Notes', 'com.apple.Notes'],
            ['Safari', 'com.apple.Safari'], ['Spotify', 'com.spotify.client'], ['System Settings', 'com.apple.systempreferences'],
            ['Terminal', 'com.apple.Terminal']].map(([name, id]) => ({ name, id }));
        case 'shortcuts.list': return ['Focus: Work', 'Start Meeting', 'Log Water'];
        case 'app.icon': return null;
        case 'display.canvas': return { width: 0, height: 0 };
        case 'teams.state':
          return { connected: true, paired: true, meeting: mockMeeting };
        case 'teams.action': {
          const flip = { 'toggle-mute': 'isMuted', 'toggle-video': 'isVideoOn', 'toggle-hand': 'isHandRaised', 'toggle-background-blur': 'isBackgroundBlurred' }[args.action];
          if (flip) mockMeeting[flip] = !mockMeeting[flip];
          if (args.action === 'leave-call') mockMeeting.isInMeeting = false;
          setTimeout(() => window.EdgeTeams && EdgeTeams.update({ connected: true, paired: true, meeting: Object.assign({}, mockMeeting) }), 50);
          return true;
        }
        case 'omnifocus.perspectives':
          return { custom: ['Today', 'Work', 'Waiting For'], builtin: ['Inbox', 'Forecast', 'Flagged'] };
        case 'omnifocus.view':
          return { perspective: args.perspective, rows: mockOmniFocus.filter((r) => !r.done) };
        case 'omnifocus.complete':
          mockOmniFocus.forEach((r) => { if (r.id === args.id) r.done = true; });
          return { ok: true };
        case 'omnifocus.plan':
          mockOmniFocus.forEach((r) => { if (r.id === args.id) r.pl = args.date; });
          return { ok: true };
        case 'omnifocus.launch': return true;
        case 'config.update': {
          const cfg = JSON.parse(localStorage.getItem('edgedeck.config') || '{}');
          const value = JSON.parse(args.json);
          if (args.section === '*') Object.assign(cfg, value);
          else if (value === null) delete cfg[args.section];
          else cfg[args.section] = value;
          localStorage.setItem('edgedeck.config', JSON.stringify(cfg));
          setTimeout(() => window.EdgeDeck && EdgeDeck.reloadConfig(), 0);
          return true;
        }
        case 'updates.state': case 'updates.check':
          return { current: '0.1.0', latest: '0.2.0', available: true, canInstall: true, checking: false, installing: false, autoCheck: true,
            checked: Date.now(), notes: 'A touch dashboard for the Corsair Xeneon Edge on macOS.\n\n- Sample release notes (preview)', page: 'https://github.com/cinsekrap/edgedeck/releases' };
        case 'updates.install': return Promise.reject(new Error('Preview only'));
        case 'updates.page': return true;
        case 'settings.open': window.open('index.html?mode=settings', '_blank'); return true;
        case 'editor.open': window.open('index.html?mode=edit', '_blank'); return true;
        case 'login.get': return { supported: true, enabled: false };
        case 'login.set': return !!args.enabled;
        case 'config.reveal': case 'permissions.open': return true;
        case 'app.front': return null;
        case 'setup.state': return { step: 0, done: false };
        case 'setup.done': case 'setup.progress': case 'setup.open': case 'app.relaunch': return true;
        case 'apps.installed': return (args.ids || []).filter((id) => ['com.microsoft.teams2', 'us.zoom.xos', 'com.omnigroup.OmniFocus4', 'com.spotify.client'].includes(id));
        case 'file.save': {   // preview: download the file
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([args.json], { type: 'application/json' }));
          a.download = args.name;
          a.click();
          return args.name;
        }
        case 'file.open': return window.__mockOpenFile || null;
        case 'elgato.list':
          return mockLights.map((l) => Object.assign({ reachable: true }, l));
        case 'elgato.set':
          mockLights.forEach((l) => { if (!args.ids || !args.ids.length || args.ids.includes(l.id)) {
            if (args.on != null) l.on = args.on; if (args.brightness != null) l.brightness = args.brightness; if (args.temperature != null) l.temperature = args.temperature; } });
          return mockLights.length;
        case 'badges.list':
          return [{ name: 'Microsoft Outlook', bundleID: 'com.microsoft.Outlook', badge: '12' }, { name: 'Microsoft Teams', bundleID: 'com.microsoft.teams2', badge: '2' },
            { name: 'WhatsApp', bundleID: 'net.whatsapp.WhatsApp', badge: '3' }, { name: 'Discord', bundleID: 'com.hnc.Discord', badge: '' }, { name: 'Microsoft To Do', bundleID: 'com.microsoft.to-do-mac', badge: '5' }];
        case 'touch.calibrate':
          if (args.reset) window.EdgeDeck && EdgeDeck.resetCalibration(); else window.EdgeDeck && EdgeDeck.calibrate();
          return true;
        case 'status':
          return { touch: 'Browser preview (no touch controller)', inputMonitoring: false, accessibility: false, calendar: 'not asked', screenFound: false, configPath: 'localStorage' };
        case 'action.run':
          console.log('[mock] action', args);
          return true;
        case 'system.stats': {
          const t = (Date.now() - mockStart) / 1000;
          return {
            cpu: 18 + 14 * Math.sin(t / 7) + Math.random() * 8,
            memory: { used: 33.5 * 2 ** 30, total: 48 * 2 ** 30 },
            network: { rx: 40000 + Math.random() * 900000, tx: 5000 + Math.random() * 60000 },
            disk: { free: 1.1e12, total: 2e12 },
            battery: { percent: 70, charging: false, pluggedIn: false },
          };
        }
        case 'audio.state':
          return {
            micName: 'MacBook Pro Microphone', micMuted: mockMicMuted,
            inputs: [{ id: 1, name: 'MacBook Pro Microphone', default: mockInput === 1 }, { id: 2, name: 'AirPods Pro', default: mockInput === 2 }],
            outputs: [{ id: 3, name: 'MacBook Pro Speakers', default: mockOutput === 3 }, { id: 2, name: 'AirPods Pro', default: mockOutput === 2 }, { id: 4, name: 'Studio Display Speakers', default: mockOutput === 4 }],
          };
        case 'audio.micMute':
          mockMicMuted = args.mute != null ? !!args.mute : !mockMicMuted;
          return { micMuted: mockMicMuted };
        case 'audio.setOutput': mockOutput = args.id; return Mock.call('audio.state');
        case 'audio.setInput': mockInput = args.id; return Mock.call('audio.state');
        case 'calendar.events': {
          const now = Date.now(), min = 60000, day = new Date(); day.setHours(0, 0, 0, 0);
          const tomorrow = day.getTime() + 86400000;
          return [
            { title: 'Design review', start: now - 20 * min, end: now + 25 * min, allDay: false, calendar: 'Work', color: '#4cc2ff', joinURL: 'https://meet.google.com/abc-defg-hij' },
            { title: '1:1 with Sam', start: now + 8 * min, end: now + 38 * min, allDay: false, calendar: 'Work', color: '#4cc2ff', joinURL: 'https://zoom.us/j/123' },
            { title: 'Gym', start: now + 4 * 60 * min, end: now + 5 * 60 * min, allDay: false, calendar: 'Home', color: '#5ad17a', location: 'PureGym' },
            { title: 'Bin day', start: tomorrow, end: tomorrow + 86400000, allDay: true, calendar: 'Home', color: '#5ad17a' },
            { title: 'Sprint planning', start: tomorrow + 9.5 * 60 * min, end: tomorrow + 10.5 * 60 * min, allDay: false, calendar: 'Work', color: '#4cc2ff' },
          ];
        }
        case 'script.run':
          return { value: '3', title: 'Inbox', subtitle: 'unread (preview)', icon: '✉️' };
        default:
          return true;
      }
    },
  };

  window.EdgeBridge = {
    native,
    call(cmd, args = {}) {
      if (!native) {
        return new Promise((resolve) => setTimeout(() => resolve(Mock.call(cmd, args)), 20));
      }
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        handler.postMessage({ id, cmd, args });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('No reply to ' + cmd));
          }
        }, 20000);
      });
    },
    _reply(id, error, value) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(value);
    },
    log(message) {
      if (native) handler.postMessage({ id: 0, cmd: 'log', args: { message: String(message) } });
      else console.log(message);
    },
  };

  window.addEventListener('error', (e) => window.EdgeBridge.log('Error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => window.EdgeBridge.log('Unhandled: ' + (e.reason && e.reason.message || e.reason)));
})();
