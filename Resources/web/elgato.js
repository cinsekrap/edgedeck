// Elgato Key Lights widget: power, brightness and colour temperature for all
// lights together or one light. The Mac app talks to the lights (ElgatoLights.swift).
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The lights take temperature in mireds; people think in kelvin (2900 K warm … 7000 K cool).
  const K_MIN = 2900, K_MAX = 7000;
  const toKelvin = (mired) => Math.round(1e6 / mired / 50) * 50;
  const toMired = (kelvin) => Math.max(143, Math.min(344, Math.round(1e6 / kelvin)));

  function slider(el, onChange) {
    let rect = null;
    const frac = (x) => Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    el._edgeDrag = {
      start(x) { rect = el.getBoundingClientRect(); onChange(frac(x), false); },
      move(x) { onChange(frac(x), false); },
      end(x) { onChange(frac(x), true); },
    };
  }

  function throttle(fn, ms) {
    let last = 0, timer = null, args;
    return (...a) => {
      args = a;
      const now = Date.now();
      if (now - last >= ms) { last = now; fn(...args); }
      else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last)); }
    };
  }

  const elgato = {
    name: 'Elgato Key Lights',
    size: [4, 2],
    props: [
      {
        key: 'light', label: 'Controls', type: 'dynamic', default: 'all',
        load: async () => {
          const lights = await EdgeBridge.call('elgato.list');
          return [['all', 'All lights together'], ...lights.map((l) => [l.id, l.name])];
        },
        hint: 'Lights are found on your network automatically.',
      },
      { key: 'title', label: 'Title (optional)', type: 'text', placeholder: 'Key Lights' },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.innerHTML = `
        <div class="kl-head"><span class="kl-name"></span><span class="kl-state"></span><span class="kl-icons"></span></div>
        <button class="kl-power pressable"><span class="kl-power-icon"></span><span class="kl-power-label">Turn on</span></button>
        <div class="kl-row"><span class="kl-label">Brightness</span><div class="kl-slider kl-bright"><div class="kl-fill"></div><div class="kl-knob"></div></div><span class="kl-value kl-bv"></span></div>
        <div class="kl-row"><span class="kl-label">Colour</span><div class="kl-slider kl-temp"><div class="kl-knob"></div></div><span class="kl-value kl-tv"></span></div>`;
      const $ = (q) => el.querySelector(q);
      const target = s.light && s.light !== 'all' ? [s.light] : [];
      let lights = null;           // latest list from the Mac
      let state = null;            // {on, brightness, temperature} shown in the widget
      let dragging = false;
      let error = '';

      const send = (change) => ctx.bridge.call('elgato.set', Object.assign({ ids: target }, change)).catch((e) => { error = e.message; render(); });
      const sendThrottled = throttle(send, 120);

      $('.kl-power')._edgeTap = () => {
        if (!state) return;
        state.on = !state.on;
        for (const l of lights || []) if (!target.length || l.id === target[0]) l.on = state.on;
        render();
        send({ on: state.on });
      };
      slider($('.kl-bright'), (f, final) => {
        if (!state) return;
        dragging = !final;
        state.brightness = Math.max(3, Math.round(f * 100));
        if (!state.on) state.on = true;   // sliding brightness turns the light on
        render();
        sendThrottled({ on: true, brightness: state.brightness });
      });
      slider($('.kl-temp'), (f, final) => {
        if (!state) return;
        dragging = !final;
        state.temperature = toMired(K_MIN + f * (K_MAX - K_MIN));
        render();
        sendThrottled({ temperature: state.temperature });
      });

      // One small light per lamp in the header, lit or not; tap one to switch just that lamp.
      let iconSig = '';
      function renderIcons(relevant) {
        const sig = JSON.stringify(relevant.map((l) => [l.id, !!l.on, l.reachable]));
        if (sig === iconSig) return;
        iconSig = sig;
        const box = $('.kl-icons');
        box.innerHTML = '';
        for (const l of relevant) {
          const b = document.createElement('button');
          b.className = 'kl-lamp pressable' + (l.on ? ' lit' : '') + (l.reachable === false ? ' gone' : '');
          b.title = l.name;
          b.innerHTML = '<span class="kl-lamp-panel"></span><span class="kl-lamp-stand"></span>';
          b._edgeTap = () => {
            l.on = !l.on;
            if (state) state.on = (lights || []).some((x) => (!target.length || x.id === target[0]) && x.on);
            render();
            ctx.bridge.call('elgato.set', { ids: [l.id], on: l.on }).catch((e) => { error = e.message; render(); });
          };
          box.appendChild(b);
        }
      }

      function render() {
        const relevant = (lights || []).filter((l) => !target.length || l.id === target[0]);
        $('.kl-name').textContent = s.title || (target.length && relevant[0] ? relevant[0].name : 'Key Lights');
        el.classList.toggle('on', !!(state && state.on));
        $('.kl-power-label').textContent = state && state.on ? 'Turn off' : 'Turn on';
        if (!state) {
          $('.kl-state').textContent = error || (lights && !relevant.length ? 'No lights found yet' : 'Looking for lights…');
          $('.kl-icons').innerHTML = '';
          return;
        }
        $('.kl-state').textContent = error;
        renderIcons(relevant);
        const b = state.brightness / 100;
        $('.kl-bright .kl-fill').style.width = b * 100 + '%';
        $('.kl-bright .kl-knob').style.left = b * 100 + '%';
        $('.kl-bv').textContent = state.brightness + '%';
        const k = Math.max(K_MIN, Math.min(K_MAX, 1e6 / state.temperature));
        $('.kl-temp .kl-knob').style.left = ((k - K_MIN) / (K_MAX - K_MIN)) * 100 + '%';
        $('.kl-tv').textContent = toKelvin(state.temperature) + ' K';
      }

      async function poll() {
        if (dragging || document.hidden) return;
        try {
          lights = await ctx.bridge.call('elgato.list');
          error = '';
          const relevant = lights.filter((l) => l.reachable && (!target.length || l.id === target[0]));
          if (relevant.length) {
            // For "all lights", show the first light's settings; on if any light is on.
            state = { on: relevant.some((l) => l.on), brightness: relevant[0].brightness, temperature: relevant[0].temperature };
          }
        } catch (e) { error = e.message; }
        render();
      }

      render();
      poll();
      // Poll quickly until the lights are found, then every 10 s (they can be changed elsewhere).
      let fast = setInterval(() => { if (state) { clearInterval(fast); fast = null; } else poll(); }, 1500);
      const slow = setInterval(poll, ctx.edit ? 30000 : 10000);
      return { destroy() { if (fast) clearInterval(fast); clearInterval(slow); } };
    },
  };

  window.Widgets.elgato = elgato;
})();
