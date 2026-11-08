// App badges widget: the red unread counts from Dock icons (Outlook, Teams,
// WhatsApp…). Tap an app to open it. The Mac app reads the Dock (DockBadges.swift).
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = new Map();   // bundle id -> data URL (or '' if none), shared by all badge widgets
  // "Microsoft Outlook" -> "Outlook": the default label when none is set.
  const shortName = (name) => String(name || '').replace(/^Microsoft\s+/, '').trim();

  const badges = {
    name: 'App badges',
    size: [5, 1],
    props: [
      {
        key: 'apps', label: 'Apps', type: 'checklist',
        load: async () => (await EdgeBridge.call('badges.list')).filter((a) => a.bundleID).map((a) => [a.bundleID, a.name]),
        hint: 'Apps in your Dock. An app only has a badge while it’s running and its notifications allow badges.',
      },
      {
        key: 'labels', label: 'Labels', type: 'labelmap', from: 'apps',
        load: async () => (await EdgeBridge.call('badges.list')).map((a) => [a.bundleID, a.name, shortName(a.name)]),
        hint: 'Leave a box empty to use the short name shown in grey.',
        showIf: (w) => w.showNames !== false && Array.isArray(w.apps) && w.apps.length > 0,
      },
      { key: 'showNames', label: 'Show labels', type: 'bool', default: true },
      { key: 'hideEmpty', label: 'Hide apps with nothing waiting', type: 'bool', default: false },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      const chosen = Array.isArray(s.apps) ? s.apps : [];
      let items = null;
      let last = '';

      function render() {
        if (!chosen.length) { el.innerHTML = `<div class="bd-msg">${ctx.edit ? 'Choose some apps' : 'No apps chosen'}</div>`; return; }
        const byID = new Map((items || []).map((a) => [a.bundleID, a]));
        const shown = chosen.map((id) => byID.get(id) || { bundleID: id, name: id.split('.').pop(), badge: '', missing: true })
          .filter((a) => !(s.hideEmpty && !a.badge));
        const sig = JSON.stringify(shown) + [...icons.keys()].length;
        if (sig === last) return;   // don't rebuild under a finger when nothing changed
        last = sig;
        if (!shown.length) { el.innerHTML = '<div class="bd-msg">Nothing waiting ✓</div>'; return; }
        el.innerHTML = shown.map((a, i) => `
          <button class="bd-app pressable${a.badge ? ' has' : ''}" data-i="${i}">
            <span class="bd-icon">${icons.get(a.bundleID) ? `<img src="${icons.get(a.bundleID)}" alt="">` : esc((a.name || '?').slice(0, 1))}
              ${a.badge ? `<span class="bd-count">${esc(a.badge)}</span>` : ''}</span>
            ${s.showNames !== false ? `<span class="bd-name">${esc(((s.labels || {})[a.bundleID] || '').trim() || shortName(a.name))}</span>` : ''}
          </button>`).join('');
        el.classList.toggle('no-names', s.showNames === false);
        el.querySelectorAll('.bd-app').forEach((b) => {
          const a = shown[+b.dataset.i];
          b._edgeTap = () => ctx.bridge.call('action.run', { type: 'app', target: a.bundleID }).catch((e) => ctx.toast(e.message, 'error'));
        });
        // Fetch any icons we don't have yet, then redraw once.
        for (const a of shown) {
          if (icons.has(a.bundleID)) continue;
          icons.set(a.bundleID, '');
          ctx.bridge.call('app.icon', { target: a.bundleID }).then((url) => { icons.set(a.bundleID, url || ''); last = ''; render(); }).catch(() => {});
        }
      }

      async function poll() {
        if (document.hidden) return;
        try { items = await ctx.bridge.call('badges.list'); } catch (e) { /* keep last */ }
        render();
      }
      render();
      poll();
      const t = setInterval(poll, ctx.edit ? 15000 : 5000);
      return { destroy: () => clearInterval(t) };
    },
  };

  window.Widgets.badges = badges;
})();
