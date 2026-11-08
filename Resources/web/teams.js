// Microsoft Teams: shared meeting state (pushed from the Mac app) and the
// Teams meeting-controls widget. The Mac app reads and presses Teams' meeting
// buttons through Accessibility; see TeamsAXClient.swift.
(function () {
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    mic: svg('M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z'),
    micOff: svg('M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z'),
    cam: svg('M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z'),
    camOff: svg('M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z'),
    leave: svg('M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z'),
  };

  // ---------------- Shared state ----------------
  const subscribers = new Set();
  const EdgeTeams = {
    state: { connected: false, paired: false, meeting: {} },
    get inMeeting() { return !!(this.state.meeting && this.state.meeting.isInMeeting); },

    subscribe(fn) {
      subscribers.add(fn);
      fn(this.state);
      return () => subscribers.delete(fn);
    },

    // Called by the Mac app with {connected, paired, meeting}.
    update(next) {
      const was = this.inMeeting;
      this.state = Object.assign({ connected: false, paired: false, meeting: {} }, next || {});
      subscribers.forEach((fn) => { try { fn(this.state); } catch (e) { EdgeBridge.log('Teams widget: ' + e.message); } });
      if (was !== this.inMeeting && window.EdgeDeck && EdgeDeck.meetingChanged) EdgeDeck.meetingChanged(this.inMeeting);
    },

    action(action, type) {
      return EdgeBridge.call('teams.action', type ? { action, type } : { action });
    },

    async refresh() {
      try { this.update(await EdgeBridge.call('teams.state')); } catch (e) { /* older app */ }
    },
  };
  window.EdgeTeams = EdgeTeams;

  // ---------------- Widget ----------------
  const REACTIONS = [['like', '👍'], ['love', '❤️'], ['applause', '👏'], ['laugh', '😂'], ['wow', '😮']];

  const teams = {
    name: 'Meeting controls (Teams / Zoom)',
    size: [8, 3],
    props: [
      { key: 'showReactions', label: 'Reactions row', type: 'bool', default: true },
      { key: 'showExtras', label: 'Blur, chat and stop-sharing buttons', type: 'bool', default: true },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s) {
      el.innerHTML = `
        <div class="tm-head"><span class="tm-logo">Teams</span><span class="tm-status"></span><span class="tm-rec">● Recording</span></div>
        <div class="tm-hint"></div>
        <div class="tm-main">
          <button class="tm-btn pressable" data-a="toggle-mute" data-p="canToggleMute"><span class="tm-icon"></span><span class="tm-label"></span></button>
          <div class="tm-split">
            <button class="tm-btn pressable" data-a="toggle-video" data-p="canToggleVideo"><span class="tm-icon"></span><span class="tm-label"></span></button>
            <button class="tm-btn pressable extra" data-a="toggle-background-blur" data-p="canToggleBlur"><span class="tm-icon tm-emoji">🌫️</span><span class="tm-label">Blur</span></button>
          </div>
          <button class="tm-btn pressable" data-a="toggle-hand" data-p="canToggleHand"><span class="tm-icon tm-emoji">✋</span><span class="tm-label">Raise hand</span></button>
          <button class="tm-btn pressable extra" data-a="toggle-ui" data-t="chat" data-p="canToggleChat"><span class="tm-icon tm-emoji">💬</span><span class="tm-label">Chat</span></button>
          <button class="tm-btn pressable extra share" data-a="stop-sharing" data-p="canStopSharing"><span class="tm-icon tm-emoji">⏹</span><span class="tm-label">Stop sharing</span></button>
          <button class="tm-btn pressable leave" data-a="leave-call" data-p="canLeave"><span class="tm-icon">${ICON.leave}</span><span class="tm-label">Leave</span></button>
        </div>
        <div class="tm-reactions">${REACTIONS.map(([t, e]) => `<button class="tm-react pressable" data-a="send-reaction" data-t="${t}" data-p="canReact">${e}</button>`).join('')}</div>`;
      const $ = (q) => el.querySelector(q);
      el.classList.toggle('no-extras', s.showExtras === false);
      let state = EdgeTeams.state;

      el.querySelectorAll('[data-a]').forEach((b) => {
        b._edgeTap = () => {
          const m = state.meeting || {};
          // Before pairing, any button press during a meeting is what makes Teams ask to
          // allow EdgeDeck, and Teams may not report meeting state yet, so always send.
          if (state.paired && (!m.isInMeeting || m[b.dataset.p] === false)) return;
          // Show the change straight away; Teams confirms with a meetingUpdate.
          const flip = { 'toggle-mute': 'isMuted', 'toggle-video': 'isVideoOn', 'toggle-hand': 'isHandRaised', 'toggle-background-blur': 'isBackgroundBlurred' }[b.dataset.a];
          if (flip && state.paired) { m[flip] = !m[flip]; render(state); }
          EdgeTeams.action(b.dataset.a, b.dataset.t).catch((e) => window.EdgeDeck && EdgeDeck.toast(e.message, 'error'));
        };
      });

      function render(st) {
        state = st;
        const m = st.meeting || {};
        const inMeeting = !!m.isInMeeting;
        el.classList.toggle('offline', !st.connected);
        el.classList.toggle('in-meeting', inMeeting);
        // Which app this meeting is in.
        $('.tm-logo').textContent = st.app || 'Teams';
        el.classList.toggle('zoom', st.app === 'Zoom');
        $('.tm-status').textContent = !st.connected ? (st.reason === 'not running' ? 'Teams not open' : 'Not connected') : inMeeting ? 'In a meeting' : 'No meeting';
        const limited = st.source === 'accessibility';
        el.classList.toggle('no-reactions', s.showReactions === false || s.h < 2);
        el.querySelector('[data-a="toggle-ui"]').style.display = limited && !m.canToggleChat ? 'none' : '';
        $('.tm-rec').style.display = m.isRecordingOn ? '' : 'none';
        $('.tm-hint').textContent = !st.connected
          ? (st.reason === 'accessibility' ? 'Allow EdgeDeck in System Settings → Privacy & Security → Accessibility.'
            : st.reason === 'not running' ? '' : 'Teams control is turned off in Settings.')
          : !st.paired ? 'During a meeting, tap any button here, then click Allow in Teams.' : '';

        const mute = $('[data-a="toggle-mute"]');
        mute.classList.toggle('alert', !!m.isMuted);
        mute.querySelector('.tm-icon').innerHTML = m.isMuted ? ICON.micOff : ICON.mic;
        mute.querySelector('.tm-label').textContent = m.isMuted ? 'Unmute' : 'Mute';
        const cam = $('[data-a="toggle-video"]');
        cam.classList.toggle('off', !m.isVideoOn);
        cam.querySelector('.tm-icon').innerHTML = m.isVideoOn ? ICON.cam : ICON.camOff;
        cam.querySelector('.tm-label').textContent = m.isVideoOn ? 'Camera off' : 'Camera on';
        $('[data-a="toggle-hand"]').classList.toggle('on', !!m.isHandRaised);
        $('[data-a="toggle-hand"] .tm-label').textContent = m.isHandRaised ? 'Lower hand' : 'Raise hand';
        // Blur shares the camera's button. It stays usable with the camera off, so you can
        // blur before anyone sees your room; it's dimmed then, as a hint it applies later.
        // The label says what a tap will do: Teams turns blur off via "No background effect".
        const blur = $('[data-a="toggle-background-blur"]');
        blur.classList.toggle('on', !!m.isBackgroundBlurred);
        blur.classList.toggle('dim', !m.isVideoOn);
        blur.querySelector('.tm-label').textContent = m.isBackgroundBlurred ? 'No background effect' : m.isVideoOn ? 'Blur' : 'Blur first';
        $('[data-a="toggle-ui"]').classList.toggle('badge', !!m.hasUnreadMessages);
        $('.share').style.display = m.isSharing ? '' : 'none';
        el.querySelectorAll('[data-p]').forEach((b) => {
          // Until paired, nothing is greyed out, so a tap can start pairing.
          b.classList.toggle('disabled', st.paired && (!inMeeting || m[b.dataset.p] === false));
        });
      }

      const unsub = EdgeTeams.subscribe(render);
      return { destroy: unsub };
    },
  };

  window.Widgets.teams = teams;
})();
