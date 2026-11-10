// OmniFocus perspective widget. Shows one of your perspectives exactly as
// OmniFocus does (the Mac app reads it from a hidden OmniFocus window; see
// OmniFocus.swift). Tap the circle to complete a task (with 3 s to undo),
// tap a task to change its planned date, hold a task to open it in OmniFocus.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const UNDO_MS = 3000;

  // ---------------- Dates ----------------
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  function at(day, hhmm) {
    const [h, m] = String(hhmm || '09:00').split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0);
  }
  const time = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  function when(ms) {
    const d = new Date(ms);
    const today = startOfDay(new Date());
    const day = startOfDay(d);
    const diff = Math.round((day - today) / 86400000);
    const label = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
      : diff > 1 && diff < 7 ? d.toLocaleDateString('en-GB', { weekday: 'long' })
      : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    return label + ' ' + time(d);
  }

  // The working-day presets. Times already past today roll on to tomorrow.
  function presets(s) {
    const now = new Date();
    const today = startOfDay(now);
    const tomorrow = addDays(today, 1);
    const roll = (t) => { const d = at(today, t); return d > now ? d : at(tomorrow, t); };
    const monday = addDays(today, ((8 - today.getDay()) % 7) || 7);   // next Monday, never today
    return [
      ['In the morning', roll(s.morning || '09:00')],
      ['In the afternoon', roll(s.afternoon || '14:00')],
      ['After work', roll(s.evening || '18:00')],
      ['Tomorrow', at(tomorrow, s.morning || '09:00')],
      ['Next week', at(monday, '09:00')],
    ];
  }

  // ---------------- Planned-date sheet ----------------
  function openSheet(task, s, ctx, onDone) {
    const backdrop = document.createElement('div');
    backdrop.className = 'of-backdrop';
    const close = () => backdrop.remove();
    backdrop._edgeTap = close;

    const panel = document.createElement('div');
    panel.className = 'of-sheet';
    panel._edgeTap = () => {};   // taps on the panel itself don't close it
    backdrop.appendChild(panel);

    const set = async (date, label) => {
      close();
      try {
        await ctx.bridge.call('omnifocus.plan', { id: task.id, date: date ? date.getTime() : null });
        ctx.toast(date ? 'Planned for ' + label : 'Planned date cleared');
        onDone();
      } catch (e) { ctx.toast(e.message, 'error'); }
    };

    const current = task.pl ? 'Planned for ' + when(task.pl) : task.epl ? 'Planned (from its project) ' + when(task.epl) : 'No planned date';
    panel.innerHTML = `
      <div class="of-sheet-head"><div class="of-sheet-title">${esc(task.n)}</div><div class="of-sheet-sub">${esc(current)}</div></div>
      <div class="of-presets"></div>
      <div class="of-pick-label">Or pick a day and time</div>
      <div class="of-chips of-days"></div>
      <div class="of-chips of-times"></div>
      <div class="of-sheet-actions">
        <button class="of-btn pressable" data-x="clear">Clear planned date</button>
        <span class="of-spacer"></span>
        <button class="of-btn pressable" data-x="cancel">Cancel</button>
        <button class="of-btn primary pressable" data-x="set" disabled>Set</button>
      </div>`;

    const presetBox = panel.querySelector('.of-presets');
    for (const [label, date] of presets(s)) {
      const b = document.createElement('button');
      b.className = 'of-preset pressable';
      b.innerHTML = `<span>${esc(label)}</span><small>${esc(when(date.getTime()))}</small>`;
      b._edgeTap = () => set(date, when(date.getTime()));
      presetBox.appendChild(b);
    }

    // Custom: a strip of days and a strip of times; Set once both are chosen.
    let day = null, hhmm = null;
    const setBtn = panel.querySelector('[data-x="set"]');
    const refreshSet = () => {
      const ok = day && hhmm;
      setBtn.disabled = !ok;
      setBtn.textContent = ok ? 'Set ' + when(at(day, hhmm).getTime()) : 'Set';
    };
    const chips = (box, items, onPick) => {
      for (const [label, value] of items) {
        const c = document.createElement('button');
        c.className = 'of-chip pressable';
        c.textContent = label;
        c._edgeTap = () => {
          box.querySelectorAll('.of-chip').forEach((x) => x.classList.toggle('on', x === c));
          onPick(value);
          refreshSet();
        };
        box.appendChild(c);
      }
    };
    const today = startOfDay(new Date());
    chips(panel.querySelector('.of-days'), Array.from({ length: 14 }, (_, i) => {
      const d = addDays(today, i);
      return [i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }), d];
    }), (v) => { day = v; });
    chips(panel.querySelector('.of-times'), Array.from({ length: 15 }, (_, i) => {
      const t = String(7 + i).padStart(2, '0') + ':00';
      return [t, t];
    }), (v) => { hhmm = v; });

    panel.querySelector('[data-x="clear"]')._edgeTap = () => set(null);
    panel.querySelector('[data-x="cancel"]')._edgeTap = close;
    setBtn._edgeTap = () => { if (day && hhmm) { const d = at(day, hhmm); set(d, when(d.getTime())); } };

    document.body.appendChild(backdrop);
  }

  // ---------------- Widget ----------------
  const omnifocus = {
    name: 'OmniFocus perspective',
    size: [4, 4],
    props: [
      {
        key: 'perspective', label: 'Perspective', type: 'dynamic',
        load: async () => {
          const r = await EdgeBridge.call('omnifocus.perspectives');
          return [...(r.custom || []), ...(r.builtin || [])].map((n) => [n, n]);
        },
        hint: 'Shown exactly as in OmniFocus. OmniFocus needs to be open.',
      },
      { key: 'title', label: 'Title (optional)', type: 'text', placeholder: 'Uses the perspective name' },
      { key: 'showProject', label: 'Show project and tags', type: 'bool', default: true },
      { key: 'columns', label: 'Layout', type: 'select', default: 'auto', options: [['auto', 'Columns to fill the width'], ['1', 'One column']] },
      { key: 'morning', label: '“In the morning” time', type: 'text', placeholder: '09:00', default: '09:00' },
      { key: 'afternoon', label: '“In the afternoon” time', type: 'text', placeholder: '14:00', default: '14:00' },
      { key: 'evening', label: '“After work” time', type: 'text', placeholder: '18:00', default: '18:00', hint: '“Tomorrow” uses the morning time; “Next week” is Monday 09:00.' },
      { key: 'refresh', label: 'Refresh every (seconds)', type: 'number', default: 30, min: 10, max: 600 },
      { key: 'color', label: 'Background', type: 'color' },
    ],
    create(el, s, ctx) {
      el.innerHTML = `
        <div class="of-head"><span class="of-title"></span><span class="of-count"></span><span class="of-status"></span></div>
        <div class="of-list"></div>`;
      const $ = (q) => el.querySelector(q);
      const list = $('.of-list');
      list._edgeScroll = true;
      let rows = null;
      let error = '';
      const pending = new Map();   // task id -> undo timer

      const meta = (t) => {
        const now = Date.now();
        const bits = [];
        if (s.showProject !== false && t.pr) bits.push(esc(t.pr));
        if (t.pl || t.epl) bits.push(`<span class="of-planned">◷ ${esc(when(t.pl || t.epl))}</span>`);
        if (t.due) bits.push(`<span class="of-due${t.due < now ? ' overdue' : ''}">Due ${esc(when(t.due))}</span>`);
        if (s.showProject !== false && t.tags && t.tags.length) bits.push(esc(t.tags.join(', ')));
        return bits.join(' · ');
      };

      // Fill columns in order, like a newspaper: a list that fits stays in one column;
      // a longer one fills column 1 to the bottom, then column 2, and so on. If even
      // all the columns can't hold it, they grow taller together and the list scrolls.
      const COL_MIN = 520, COL_GAP = 28;
      function layoutColumns() {
        const cols = list.querySelector('.of-cols');
        if (!cols) return;
        cols.style.columnCount = '';
        cols.style.height = '';
        const n = s.columns === '1' ? 1 : Math.max(1, Math.floor((list.clientWidth + COL_GAP) / (COL_MIN + COL_GAP)));
        const total = cols.scrollHeight;
        const available = list.clientHeight - 12;
        if (n === 1 || total <= available) return;
        cols.style.columnCount = String(n);
        let height = Math.max(available, Math.ceil(total / n) + 40);
        cols.style.height = height + 'px';
        // Rows never split across columns, so allow for that: grow until nothing spills past the last column.
        for (let i = 0; i < 40 && cols.scrollWidth > cols.clientWidth + 2; i++) {
          height += 40;
          cols.style.height = height + 'px';
        }
      }

      function render() {
        $('.of-title').textContent = s.title || s.perspective || 'OmniFocus';
        const tasks = rows ? rows.filter((r) => r.k === 't' && !r.done) : [];
        $('.of-count').textContent = rows ? String(tasks.length) : '';
        $('.of-status').textContent = error && rows ? '⚠︎' : '';
        if (!s.perspective) { list.innerHTML = `<div class="of-msg">${ctx.edit ? 'Choose a perspective' : 'Not set up'}</div>`; return; }
        if (!rows) {
          list.innerHTML = error
            ? `<div class="of-msg">${esc(error)}${/isn.t open/.test(error) ? '<br><button class="of-btn pressable of-launch">Open OmniFocus</button>' : ''}</div>`
            : '<div class="of-msg">Loading…</div>';
          const launch = list.querySelector('.of-launch');
          if (launch) launch._edgeTap = () => ctx.bridge.call('omnifocus.launch').then(() => setTimeout(() => p.run(), 3000));
          return;
        }
        if (!rows.length) { list.innerHTML = '<div class="of-msg">Nothing here 🎉</div>'; return; }

        const scroll = list.scrollTop;
        list.innerHTML = `<div class="of-cols${s.columns === '1' ? ' single' : ''}">` + rows.map((r, i) => r.k === 'g'
          ? (r.n ? `<div class="of-group" style="--d:${r.d}">${esc(r.n)}</div>` : '')
          : `<div class="of-task${pending.has(r.id) || r.done ? ' pending' : ''}" data-i="${i}" style="--d:${r.d}">
               <button class="of-check pressable" data-i="${i}"><span class="of-circle"></span></button>
               <div class="of-text"><div class="of-name">${r.f ? '<span class="of-flag">⚑</span> ' : ''}${esc(r.n)}</div>
                 <div class="of-meta">${meta(r)}</div></div>
               ${pending.has(r.id) ? `<button class="of-undo pressable" data-i="${i}">Undo</button>` : ''}
             </div>`).join('') + '</div>';
        layoutColumns();
        list.scrollTop = scroll;

        list.querySelectorAll('.of-task').forEach((row) => {
          const t = rows[+row.dataset.i];
          row._edgeTap = () => { if (!pending.has(t.id)) openSheet(t, s, ctx, () => p.run()); };
          row._edgeLong = () => ctx.bridge.call('action.run', { type: 'url', target: 'omnifocus:///task/' + encodeURIComponent(t.id) });
        });
        list.querySelectorAll('.of-check').forEach((b) => {
          const t = rows[+b.dataset.i];
          b._edgeTap = () => {
            if (pending.has(t.id) || t.done) return;
            // Give 3 seconds to undo before telling OmniFocus.
            pending.set(t.id, setTimeout(async () => {
              try {
                await ctx.bridge.call('omnifocus.complete', { id: t.id });
                t.done = true;
              } catch (e) { ctx.toast(e.message, 'error'); }
              pending.delete(t.id);
              render();
              p.run();
            }, UNDO_MS));
            render();
          };
        });
        list.querySelectorAll('.of-undo').forEach((b) => {
          const t = rows[+b.dataset.i];
          b._edgeTap = () => { clearTimeout(pending.get(t.id)); pending.delete(t.id); render(); };
        });
      }

      // Poll, but don't redraw under a finger mid-undo; completed tasks drop out on the next read.
      let busy = false;
      const load = async () => {
        if (busy || document.hidden || !s.perspective) { render(); return; }
        busy = true;
        try {
          const r = await ctx.bridge.call('omnifocus.view', { perspective: s.perspective });
          rows = r.rows || [];
          error = '';
        } catch (e) { error = e.message; }
        busy = false;
        render();
      };
      const p = { run: load };
      render();
      load();
      const timer = ctx.edit ? null : setInterval(load, Math.max(10, Number(s.refresh) || 30) * 1000);
      return {
        destroy() {
          clearInterval(timer);
          // Anything still waiting out its undo is completed now rather than lost.
          for (const [id, t] of pending) { clearTimeout(t); ctx.bridge.call('omnifocus.complete', { id }).catch(() => {}); }
        },
      };
    },
  };

  window.Widgets.omnifocus = omnifocus;
})();
