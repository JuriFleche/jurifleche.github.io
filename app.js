/* Juri'Fléché — moteur de jeu, grille du jour, archives, série, chrono, partage */
(function () {
  'use strict';
  const SITE = 'https://jurifleche.github.io';
  const $ = id => document.getElementById(id);
  const K = (r, c) => `${r},${c}`;

  // ---------- stockage local (toujours protégé) ----------
  const store = {
    get(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  };
  const gKey = n => `jf-grille-${n}`;

  // ---------- dates (heure de Paris) ----------
  function todayParis() {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function dayBefore(iso) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
  function longDate(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    const s = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function shortDate(iso) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  const fmt = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60), r = s % 60; return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; };

  let GRIDS = [];
  let TODAY = todayParis();

  // ---------- statistiques ----------
  function computeStats() {
    const solvedDays = new Set();
    let solved = 0;
    GRIDS.forEach(g => {
      const st = store.get(gKey(g.n), null);
      if (st && st.solved) { solved++; if (st.solved.onDay) solvedDays.add(g.date); }
    });
    // série : jours consécutifs jusqu'à aujourd'hui (ou hier si la grille du jour n'est pas encore faite)
    let d = solvedDays.has(TODAY) ? TODAY : dayBefore(TODAY), streak = 0;
    while (solvedDays.has(d)) { streak++; d = dayBefore(d); }
    const best = Math.max(streak, store.get('jf-best', 0));
    if (best > store.get('jf-best', 0)) store.set('jf-best', best);
    return { streak, best, solved };
  }
  function renderStats(host) {
    const s = computeStats();
    host.innerHTML = '';
    [[s.streak, s.streak > 1 ? 'jours de série' : 'jour de série'], [s.best, 'meilleure série'], [s.solved, s.solved > 1 ? 'grilles résolues' : 'grille résolue']]
      .forEach(([n, l]) => { const d = document.createElement('span'); d.className = 'stat'; d.innerHTML = `<b>${n}</b> ${l}`; host.appendChild(d); });
    return s;
  }

  // ---------- moteur de grille ----------
  const NS = 'http://www.w3.org/2000/svg';
  function arrowEl(type, halfY, bottomX) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('arrow', 'a-' + type);
    if (type === 'A0') { svg.setAttribute('viewBox', '0 0 10 10'); svg.innerHTML = '<path d="M1 0 L10 5 L1 10 Z"/>'; svg.style.top = halfY + '%'; }
    else if (type === 'D0') { svg.setAttribute('viewBox', '0 0 10 10'); svg.innerHTML = '<path d="M0 1 L10 1 L5 10 Z"/>'; svg.style.left = bottomX + '%'; }
    else if (type === 'D1') { svg.setAttribute('viewBox', '0 0 12 16'); svg.innerHTML = '<path class="stem" d="M0 2 H6 V11"/><path d="M2 10 L10 10 L6 16 Z"/>'; svg.style.top = halfY + '%'; }
    else { svg.setAttribute('viewBox', '0 0 16 12'); svg.innerHTML = '<path class="stem" d="M2 0 V6 H11"/><path d="M10 2 L10 10 L16 6 Z"/>'; svg.style.left = bottomX + '%'; }
    return svg;
  }
  function norm(ch) {
    return (ch || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/Œ/g, 'O').replace(/Æ/g, 'A').replace(/[^A-Z]/g, '');
  }

  let P = null;           // grille en cours
  let suppressFocus = false;
  let timerHandle = null;

  function mount(g) {
    const { R, C, cells, words } = g;
    const gridEl = $('grid');
    gridEl.innerHTML = ''; gridEl.className = 'grid';
    $('board').style.setProperty('--cols', C); gridEl.style.setProperty('--cols', C);
    const byId = Object.fromEntries(words.map(w => [w.id, w]));
    const cellWords = {};
    const posOf = (w, i) => w.d === 'A' ? [w.r, w.c + i] : [w.r + i, w.c];
    words.forEach(w => { for (let i = 0; i < w.answer.length; i++) { const [r, c] = posOf(w, i); (cellWords[K(r, c)] = cellWords[K(r, c)] || []).push(w.id); } });
    const saved = store.get(gKey(g.n), {});
    P = {
      g, byId, cellWords, posOf, inputs: {}, defEls: {}, listItems: {},
      entries: saved.entries || {}, revealed: saved.revealed || {},
      hints: new Set(saved.hints || []), reveals: saved.reveals || 0,
      elapsed: saved.elapsed || 0, solved: saved.solved || null, started: !!saved.started,
      cur: { word: null, r: null, c: null }, showHint: false, locked: {}, prevDone: null
    };
    const sorted = [...words].sort((a, b) => a.n - b.n);
    P.sorted = sorted;

    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const cell = cells[r][c];
      const div = document.createElement('div');
      div.className = 'cell';
      if (cell.t === 'L') {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.maxLength = 2; inp.autocomplete = 'off'; inp.spellcheck = false;
        inp.setAttribute('autocapitalize', 'characters'); inp.setAttribute('autocorrect', 'off');
        inp.id = `c-${r}-${c}`;
        const ws = (cellWords[K(r, c)] || []).map(id => byId[id]);
        inp.setAttribute('aria-label', `Case ligne ${r + 1}, colonne ${c + 1}` + (ws.length ? `, définition ${ws.map(w => w.n).join(' et ')}` : ''));
        div.appendChild(inp);
        P.inputs[K(r, c)] = inp;
        bindInput(inp, r, c);
      } else if (cell.t === 'C') {
        div.classList.add('clue');
        const nb = cell.clues.length;
        const bottomCount = cell.clues.filter(id => byId[id].arrow === 'A1' || byId[id].arrow === 'D0').length;
        cell.clues.forEach((id, i) => {
          const w = byId[id];
          const d = document.createElement('div');
          d.className = 'cdef';
          d.innerHTML = `<span class="t" lang="fr"></span><span class="n">${w.n}</span>`;
          d.querySelector('.t').textContent = w.short;
          d.title = `${w.n}. ${w.short} (${w.answer.length} lettres)`;
          d.setAttribute('role', 'button');
          d.setAttribute('aria-label', `Définition ${w.n} : ${w.short}, ${w.answer.length} lettres`);
          d.addEventListener('click', e => { e.stopPropagation(); selectWord(w.id, true); });
          div.appendChild(d);
          P.defEls[w.id] = d;
          const halfY = nb === 1 ? 50 : (i === 0 ? 25 : 75);
          let bx = 50;
          if (bottomCount === 2) bx = (w.arrow === 'A1') ? 18 : 70; else if (w.arrow === 'A1') bx = 30;
          div.appendChild(arrowEl(w.arrow, halfY, bx));
        });
      } else { div.classList.add('void'); div.setAttribute('aria-hidden', 'true'); }
      gridEl.appendChild(div);
    }

    // listes
    ['clAcross', 'clDown'].forEach(id => { const h = $(id); while (h.children.length > 1) h.removeChild(h.lastChild); });
    sorted.forEach(w => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cl-item';
      b.innerHTML = `<span class="cl-n">${w.n}</span><span class="cl-t"></span><span class="cl-len">${w.answer.length}</span>`;
      b.querySelector('.cl-t').textContent = w.short;
      b.addEventListener('click', () => { selectWord(w.id, true); gridEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
      $(w.d === 'A' ? 'clAcross' : 'clDown').appendChild(b);
      P.listItems[w.id] = b;
    });
    const tb = $('solBody'); tb.innerHTML = '';
    sorted.forEach(w => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="n"></td><td class="ans"></td><td class="def"></td><td class="src"></td>';
      tr.querySelector('.n').textContent = w.n;
      tr.querySelector('.ans').textContent = w.answer;
      tr.querySelector('.def').textContent = w.full;
      const src = tr.querySelector('.src');
      if (w.url) { const a = document.createElement('a'); a.href = w.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = w.ref; src.appendChild(a); }
      else src.textContent = w.ref;
      tb.appendChild(tr);
    });
    $('solutions').open = false;
    $('banner').hidden = true; $('win').hidden = true; $('shareText').hidden = true;
    P.showHint = false; $('hintBtn').textContent = 'Indice'; $('hintBtn').setAttribute('aria-expanded', 'false');
    resetZone();
    render();
    fitSoon();
    tickTimer();
    if (P.solved) showWin(false);
  }

  // mode compact et ajustement du texte des définitions
  let openedByUser = false;
  const ro = new ResizeObserver(() => {
    const gridEl = $('grid');
    const first = gridEl.querySelector('.cell');
    const w = first ? first.getBoundingClientRect().width : 60;
    const compact = w < 50;
    gridEl.classList.toggle('compact', compact);
    if (compact && !openedByUser) $('clueList').open = true;
    if (!compact) fitClues();
  });
  $('clueList').addEventListener('toggle', e => { if (e.isTrusted) openedByUser = true; });
  ro.observe($('grid'));
  function fitClues() {
    $('grid').querySelectorAll('.cdef').forEach(d => {
      const t = d.querySelector('.t'); t.style.fontSize = '';
      let size = parseFloat(getComputedStyle(t).fontSize), guard = 0;
      while ((d.scrollHeight > d.clientHeight + 1 || d.scrollWidth > d.clientWidth + 1) && size > 6 && guard++ < 24) { size -= 0.5; t.style.fontSize = size + 'px'; }
    });
  }
  function fitSoon() { requestAnimationFrame(fitClues); if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitClues); }

  function save() {
    store.set(gKey(P.g.n), { entries: P.entries, revealed: P.revealed, hints: [...P.hints], reveals: P.reveals, elapsed: P.elapsed, solved: P.solved, started: P.started });
  }
  function wordDone(w) { for (let i = 0; i < w.answer.length; i++) { const [r, c] = P.posOf(w, i); if (P.entries[K(r, c)] !== w.answer[i]) return false; } return true; }
  const isLocked = (r, c) => !!P.locked[K(r, c)];

  function computeLocks() {
    const next = {}, done = new Set();
    P.g.words.forEach(w => { if (!wordDone(w)) return; done.add(w.id); for (let i = 0; i < w.answer.length; i++) { const [r, c] = P.posOf(w, i); next[K(r, c)] = 1; } });
    if (P.prevDone) P.g.words.forEach(w => {
      if (done.has(w.id) && !P.prevDone.has(w.id)) for (let i = 0; i < w.answer.length; i++) {
        const [r, c] = P.posOf(w, i); const el = P.inputs[K(r, c)].parentElement;
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 750);
      }
    });
    P.prevDone = done; P.locked = next;
    return done.size;
  }
  function nudge(r, c) { const el = P.inputs[K(r, c)].parentElement; el.classList.remove('nudge'); void el.offsetWidth; el.classList.add('nudge'); setTimeout(() => el.classList.remove('nudge'), 300); }

  function render() {
    const gridEl = $('grid');
    const doneCount = computeLocks();
    for (const key in P.inputs) {
      const inp = P.inputs[key], v = P.entries[key] || '';
      if (inp.value !== v) inp.value = v;
      inp.parentElement.classList.toggle('revealed', !!P.revealed[key]);
      inp.parentElement.classList.toggle('locked', !!P.locked[key]);
      inp.setAttribute('aria-readonly', P.locked[key] ? 'true' : 'false');
    }
    gridEl.querySelectorAll('.in-word, .active').forEach(e => e.classList.remove('in-word', 'active'));
    gridEl.querySelectorAll('.cdef.sel').forEach(e => e.classList.remove('sel'));
    Object.values(P.listItems).forEach(b => b.classList.remove('sel'));
    const cur = P.cur;
    if (cur.word != null) {
      const w = P.byId[cur.word];
      for (let i = 0; i < w.answer.length; i++) { const [r, c] = P.posOf(w, i); P.inputs[K(r, c)].parentElement.classList.add('in-word'); }
      if (P.defEls[w.id]) P.defEls[w.id].classList.add('sel');
      P.listItems[w.id].classList.add('sel');
      if (cur.r != null) P.inputs[K(cur.r, cur.c)].parentElement.classList.add('active');
      $('cbNum').textContent = w.n;
      $('cbText').textContent = w.short;
      $('cbMeta').textContent = `${w.d === 'A' ? 'Horizontalement' : 'Verticalement'} · ${w.answer.length} lettres`;
      const hint = $('cbHint');
      hint.hidden = !P.showHint;
      if (P.showHint) { hint.innerHTML = '<b>Indice :</b> '; hint.append(w.long); if (!P.hints.has(w.id)) { P.hints.add(w.id); save(); } }
    } else {
      $('cbNum').textContent = '·'; $('cbText').textContent = 'Touchez une case pour commencer';
      $('cbMeta').textContent = 'Les flèches rouges indiquent le sens de chaque réponse.'; $('cbHint').hidden = true;
    }
    let filled = 0; const total = Object.keys(P.inputs).length;
    for (const key in P.inputs) if (P.entries[key]) filled++;
    P.g.words.forEach(w => { const d = !!P.prevDone && P.prevDone.has(w.id); if (P.defEls[w.id]) P.defEls[w.id].classList.toggle('done', d); P.listItems[w.id].classList.toggle('done', d); });
    $('status').textContent = `${filled} / ${total} cases remplies`;
    const solvedNow = doneCount === P.g.words.length;
    gridEl.classList.toggle('solved', solvedNow);
    const banner = $('banner');
    if (solvedNow) {
      banner.hidden = true;
      if (!P.solved) {
        P.solved = { time: Math.round(P.elapsed), hints: P.hints.size, reveals: P.reveals, onDay: P.g.date === todayParis(), at: Date.now() };
        save(); showWin(true);
      }
    } else if (filled === total) {
      banner.hidden = false; banner.classList.add('err');
      banner.textContent = 'Toutes les cases sont remplies, mais il reste des erreurs. Utilisez « Vérifier » pour les repérer.';
    } else if (!banner.dataset.sticky) banner.hidden = true;
  }

  function selectWord(id, focusFirstEmpty) {
    const w = P.byId[id];
    P.cur.word = id;
    let target = -1;
    if (focusFirstEmpty) {
      for (let i = 0; i < w.answer.length; i++) { const [r, c] = P.posOf(w, i); if (!P.entries[K(r, c)]) { target = i; break; } }
      if (target < 0) for (let i = 0; i < w.answer.length; i++) { const [r, c] = P.posOf(w, i); if (!isLocked(r, c)) { target = i; break; } }
    }
    if (target < 0) target = 0;
    const [r, c] = P.posOf(w, target);
    P.cur.r = r; P.cur.c = c;
    focusCell(r, c); render();
  }
  function focusCell(r, c) { const inp = P.inputs[K(r, c)]; if (inp && document.activeElement !== inp) { suppressFocus = true; inp.focus({ preventScroll: true }); suppressFocus = false; } }
  function pickWordFor(r, c, dir) { const ids = P.cellWords[K(r, c)] || []; if (!ids.length) return null; const s = ids.find(id => P.byId[id].d === dir); return s != null ? s : ids[0]; }
  function step(delta) {
    if (P.cur.word == null) return false;
    const w = P.byId[P.cur.word];
    const j = (w.d === 'A' ? P.cur.c - w.c : P.cur.r - w.r) + delta;
    if (j < 0 || j >= w.answer.length) return false;
    const [r, c] = P.posOf(w, j); P.cur.r = r; P.cur.c = c; focusCell(r, c); return true;
  }
  function moveWord(delta) { const order = P.sorted.map(w => w.id); let i = order.indexOf(P.cur.word); i = (i + delta + order.length) % order.length; selectWord(order[i], true); }
  function clearMarks() { $('grid').querySelectorAll('.wrong').forEach(e => e.classList.remove('wrong')); }
  function startClock() { if (!P.started && !P.solved) { P.started = true; save(); } }

  function bindInput(inp, r, c) {
    function enterChar(ch) {
      if (P.solved) { inp.value = P.entries[K(r, c)] || ''; return; }
      if (P.cur.word == null || !(P.cellWords[K(r, c)] || []).includes(P.cur.word)) P.cur.word = pickWordFor(r, c, 'A');
      P.cur.r = r; P.cur.c = c;
      startClock();
      if (isLocked(r, c)) { inp.value = P.entries[K(r, c)] || ''; if (ch !== P.entries[K(r, c)]) nudge(r, c); }
      else { P.entries[K(r, c)] = ch; delete P.revealed[K(r, c)]; inp.value = ch; inp.parentElement.classList.remove('wrong'); save(); }
      step(1); render();
    }
    inp.addEventListener('focus', () => {
      if (suppressFocus) return;
      const ids = P.cellWords[K(r, c)] || [];
      if (!(P.cur.word != null && ids.includes(P.cur.word))) P.cur.word = pickWordFor(r, c, P.cur.word != null ? P.byId[P.cur.word].d : 'A');
      P.cur.r = r; P.cur.c = c; render();
      setTimeout(() => { try { inp.setSelectionRange(0, inp.value.length); } catch (e) {} }, 0);
    });
    inp.addEventListener('mousedown', () => {
      if (document.activeElement === inp) { const ids = P.cellWords[K(r, c)] || []; if (ids.length > 1) { P.cur.word = ids.find(id => id !== P.cur.word); render(); } }
    });
    inp.addEventListener('input', () => {
      const ch = norm(inp.value).slice(-1);
      if (ch) { enterChar(ch); return; }
      if (isLocked(r, c) || P.solved) { inp.value = P.entries[K(r, c)] || ''; nudge(r, c); return; }
      inp.parentElement.classList.remove('wrong'); delete P.entries[K(r, c)]; inp.value = ''; save(); render();
    });
    inp.addEventListener('keydown', e => {
      const key = e.key;
      if (key === 'Backspace' || key === 'Delete') {
        e.preventDefault();
        if (P.solved) return;
        if (!isLocked(r, c) && P.entries[K(r, c)]) { inp.parentElement.classList.remove('wrong'); delete P.entries[K(r, c)]; delete P.revealed[K(r, c)]; }
        else if (key === 'Backspace' && step(-1)) { if (!isLocked(P.cur.r, P.cur.c)) { P.inputs[K(P.cur.r, P.cur.c)].parentElement.classList.remove('wrong'); delete P.entries[K(P.cur.r, P.cur.c)]; delete P.revealed[K(P.cur.r, P.cur.c)]; } }
        else if (isLocked(r, c)) nudge(r, c);
        save(); render(); return;
      }
      const moves = { ArrowRight: [0, 1, 'A'], ArrowLeft: [0, -1, 'A'], ArrowDown: [1, 0, 'D'], ArrowUp: [-1, 0, 'D'] };
      if (moves[key]) {
        e.preventDefault();
        const [dr, dc, dir] = moves[key];
        const curDir = P.cur.word != null ? P.byId[P.cur.word].d : null;
        const alt = (P.cellWords[K(r, c)] || []).find(id => P.byId[id].d === dir);
        if (curDir !== dir && alt != null) { P.cur.word = alt; render(); return; }
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < P.g.R && cc >= 0 && cc < P.g.C && !P.inputs[K(rr, cc)]) { rr += dr; cc += dc; }
        if (P.inputs[K(rr, cc)]) { P.cur.word = pickWordFor(rr, cc, dir); P.cur.r = rr; P.cur.c = cc; suppressFocus = true; P.inputs[K(rr, cc)].focus(); suppressFocus = false; render(); }
        return;
      }
      if (key === 'Tab') { e.preventDefault(); moveWord(e.shiftKey ? -1 : 1); return; }
      if (key === 'Enter' || key === ' ') { e.preventDefault(); const ids = P.cellWords[K(r, c)] || []; if (ids.length > 1) { P.cur.word = ids.find(id => id !== P.cur.word); render(); } return; }
      if (key.length === 1 && norm(key)) { e.preventDefault(); enterChar(norm(key)); }
    });
  }

  // ---------- chrono ----------
  function tickTimer() {
    clearInterval(timerHandle);
    const show = () => { $('timer').textContent = fmt(P.solved ? P.solved.time : P.elapsed); };
    show();
    let last = performance.now();
    timerHandle = setInterval(() => {
      const now = performance.now(), dt = (now - last) / 1000; last = now;
      if (P && P.started && !P.solved && document.visibilityState === 'visible') { P.elapsed += dt; show(); if (Math.round(P.elapsed) % 5 === 0) save(); }
      // passage à minuit : nouvelle grille du jour
      const t = todayParis();
      if (t !== TODAY) { TODAY = t; if (currentRoute().name === 'today') route(); }
    }, 1000);
  }
  document.addEventListener('visibilitychange', () => { if (P) save(); });

  // ---------- boutons ----------
  $('hintBtn').addEventListener('click', e => {
    P.showHint = !P.showHint;
    e.currentTarget.setAttribute('aria-expanded', String(P.showHint));
    e.currentTarget.textContent = P.showHint ? 'Masquer' : 'Indice';
    if (P.cur.word == null) selectWord(P.sorted[0].id, true); else render();
  });
  $('checkBtn').addEventListener('click', () => {
    clearMarks();
    let wrong = 0, empty = 0;
    for (const key in P.inputs) {
      const [r, c] = key.split(',').map(Number);
      if (!P.entries[key]) { empty++; continue; }
      if (P.entries[key] !== P.g.cells[r][c].a) { wrong++; P.inputs[key].parentElement.classList.add('wrong'); }
    }
    const b = $('banner'); b.hidden = false; b.dataset.sticky = '1'; b.classList.toggle('err', wrong > 0);
    b.textContent = wrong
      ? `${wrong} lettre${wrong > 1 ? 's' : ''} à revoir (en rouge)${empty ? `, ${empty} case${empty > 1 ? 's' : ''} encore vide${empty > 1 ? 's' : ''}` : ''}.`
      : (empty ? `Aucune erreur pour l'instant. Encore ${empty} case${empty > 1 ? 's' : ''} à remplir.` : 'Tout est juste !');
    setTimeout(() => { delete b.dataset.sticky; }, 6000);
    if (P.cur.r != null) focusCell(P.cur.r, P.cur.c);
  });
  $('revealCell').addEventListener('click', () => {
    if (P.solved) return;
    if (P.cur.r == null) selectWord(P.sorted[0].id, true);
    if (isLocked(P.cur.r, P.cur.c) && P.cur.word != null) {
      const w = P.byId[P.cur.word];
      for (let i = 0; i < w.answer.length; i++) { const [r, c] = P.posOf(w, i); if (!isLocked(r, c) && P.entries[K(r, c)] !== w.answer[i]) { P.cur.r = r; P.cur.c = c; break; } }
      if (isLocked(P.cur.r, P.cur.c)) { render(); return; }
      focusCell(P.cur.r, P.cur.c);
    }
    const key = K(P.cur.r, P.cur.c);
    startClock();
    P.entries[key] = P.g.cells[P.cur.r][P.cur.c].a; P.revealed[key] = 1; P.reveals++;
    P.inputs[key].parentElement.classList.remove('wrong');
    save(); step(1); render();
  });
  $('revealWord').addEventListener('click', () => {
    if (P.solved) return;
    if (P.cur.word == null) selectWord(P.sorted[0].id, true);
    const w = P.byId[P.cur.word];
    let changed = false;
    startClock();
    for (let i = 0; i < w.answer.length; i++) {
      const [r, c] = P.posOf(w, i), key = K(r, c);
      if (P.entries[key] !== w.answer[i]) { P.entries[key] = w.answer[i]; P.revealed[key] = 1; changed = true; }
      P.inputs[key].parentElement.classList.remove('wrong');
    }
    if (changed) P.reveals++;
    save(); render();
  });
  function resetZone() {
    const zone = $('dangerZone');
    zone.innerHTML = '<button type="button" id="clearBtn">Effacer tout</button>';
    $('clearBtn').addEventListener('click', () => {
      zone.innerHTML = '<span>Effacer toute la grille ?</span><button type="button" class="warn" id="yesClear">Oui, effacer</button><button type="button" id="noClear">Annuler</button>';
      $('yesClear').addEventListener('click', () => {
        Object.assign(P, { entries: {}, revealed: {}, hints: new Set(), reveals: 0, elapsed: 0, solved: null, started: false, prevDone: null });
        clearMarks(); save(); resetZone(); $('win').hidden = true; $('banner').hidden = true; delete $('banner').dataset.sticky;
        tickTimer(); render(); renderStats($('stats'));
      });
      $('noClear').addEventListener('click', resetZone);
    });
  }

  // ---------- victoire et partage ----------
  function shareText() {
    const s = P.solved, st = computeStats();
    const lines = [`Juri'Fléché n° ${P.g.n} · ${shortDate(P.g.date)}`, `✅ Résolue en ${fmt(s.time)}`];
    const aides = [];
    if (s.hints) aides.push(`${s.hints} indice${s.hints > 1 ? 's' : ''}`);
    if (s.reveals) aides.push(`${s.reveals} révélation${s.reveals > 1 ? 's' : ''}`);
    lines.push(aides.length ? `💡 ${aides.join(' · ')}` : '🎯 Sans aide');
    if (s.onDay && st.streak > 0) lines.push(`🔥 Série : ${st.streak} jour${st.streak > 1 ? 's' : ''}`);
    lines.push(SITE);
    return lines.join('\n');
  }
  function showWin(fresh) {
    const s = P.solved, st = renderStats($('stats'));
    $('win').hidden = false;
    $('winTitle').textContent = fresh ? 'Bravo, maître !' : 'Grille déjà résolue';
    const line = $('winLine'); line.innerHTML = '';
    const items = [[fmt(s.time), 'de chrono'], [s.hints, s.hints > 1 ? 'indices' : 'indice'], [s.reveals, s.reveals > 1 ? 'révélations' : 'révélation']];
    if (s.onDay) items.push([st.streak, st.streak > 1 ? 'jours de série' : 'jour de série']);
    items.forEach(([v, l]) => { const span = document.createElement('span'); span.innerHTML = `<b>${v}</b> ${l}`; line.appendChild(span); });
    $('timer').textContent = fmt(s.time);
    if (fresh) $('win').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  $('shareBtn').addEventListener('click', async () => {
    const text = shareText();
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { /* annulé ou refusé : on copie */ } }
    try { await navigator.clipboard.writeText(text); $('copied').hidden = false; setTimeout(() => { $('copied').hidden = true; }, 2500); }
    catch (e) { const ta = $('shareText'); ta.hidden = false; ta.value = text; ta.focus(); ta.select(); }
  });

  // ---------- vues et navigation ----------
  function currentRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    if (h.startsWith('archives')) return { name: 'archives' };
    if (h.startsWith('aide')) return { name: 'help' };
    const m = h.match(/^grille\/(\d+)/);
    if (m) return { name: 'grid', n: +m[1] };
    return { name: 'today' };
  }
  const published = () => GRIDS.filter(g => window.PREVIEW_ALL || g.date <= TODAY);
  function show(view) {
    $('viewGrid').hidden = view !== 'grid'; $('viewArch').hidden = view !== 'archives'; $('viewHelp').hidden = view !== 'help';
  }
  function setNav(name) {
    [['navToday', 'today'], ['navArch', 'archives'], ['navHelp', 'help']].forEach(([id, n]) => {
      if (n === name) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
    });
  }
  function openGrid(g, isToday) {
    show('grid');
    $('gTitle').innerHTML = '';
    $('gTitle').append(isToday ? 'Grille du jour' : `Grille n° ${g.n}`);
    const sm = document.createElement('small'); sm.textContent = isToday ? `n° ${g.n} · ${longDate(g.date)}` : longDate(g.date); $('gTitle').appendChild(sm);
    if (P && P.g.n !== g.n) save();
    mount(g);
    renderStats($('stats'));
  }
  function route() {
    TODAY = todayParis();
    const r = currentRoute();
    setNav(r.name === 'grid' ? 'archives' : r.name);
    $('gNotice').hidden = true;
    if (r.name === 'help') { show('help'); return; }
    if (r.name === 'archives') { renderArchives(); return; }
    const pub = published();
    if (r.name === 'grid') {
      const g = pub.find(x => x.n === r.n);
      if (g) { openGrid(g, g.date === TODAY); return; }
    }
    const today = pub.find(g => g.date === TODAY) || pub[pub.length - 1];
    if (!today) {
      show('grid'); $('gTitle').textContent = 'Bientôt';
      $('gNotice').hidden = false; $('gNotice').textContent = 'La première grille arrive très vite. Revenez demain !';
      return;
    }
    openGrid(today, today.date === TODAY);
    if (today.date !== TODAY) { $('gNotice').hidden = false; $('gNotice').textContent = "La grille d'aujourd'hui n'est pas encore en ligne. Voici la dernière grille publiée."; }
  }
  function renderArchives() {
    show('archives');
    renderStats($('stats2'));
    const host = $('archList'); host.innerHTML = '';
    [...published()].reverse().forEach(g => {
      const st = store.get(gKey(g.n), null);
      const a = document.createElement('a'); a.href = `#/grille/${g.n}`;
      const num = document.createElement('span'); num.className = 'num'; num.textContent = `n° ${g.n}`;
      const d = document.createElement('span'); d.className = 'd'; d.textContent = g.date === TODAY ? "Aujourd'hui" : shortDate(g.date);
      const s = document.createElement('span'); s.className = 'st';
      if (st && st.solved) { s.classList.add('ok'); s.textContent = `Résolue · ${fmt(st.solved.time)}`; }
      else if (st && st.started) { s.classList.add('go'); s.textContent = 'En cours'; }
      else { s.classList.add('todo'); s.textContent = 'À faire'; }
      a.append(num, d, s); host.appendChild(a);
    });
  }
  window.addEventListener('hashchange', route);

  // ---------- démarrage ----------
  async function load() {
    if (window.GRILLES_INLINE) return window.GRILLES_INLINE;
    const res = await fetch('grilles.json', { cache: 'no-cache' });
    return res.json();
  }
  load().then(data => { GRIDS = data.sort((a, b) => a.n - b.n); route(); })
    .catch(() => { show('help'); $('viewHelp').insertAdjacentHTML('afterbegin', '<p class="notice">Impossible de charger les grilles. Rechargez la page dans un instant.</p>'); });
})();
