(() => {
  'use strict';

  const LOCAL_KEY = 'padel-toernooi-v1';
  // Online staat een kopie van het gedeelde toernooi apart, zodat een lokaal toernooi bewaard blijft.
  const STORE_KEY = Cloud.enabled ? 'padel-toernooi-online-v1' : LOCAL_KEY;
  const LEADER_KEY = 'padel-toernooi-leader';
  const BEAMER = new URLSearchParams(location.search).has('beamer');
  const uid = Scheduler.uid;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const KO_TEAMS = { none: 0, final: 2, semi: 4, quarter: 8, eighth: 16 };
  const KO_NAMES = { 2: 'Finale', 4: 'Halve finale', 8: 'Kwartfinale', 16: 'Achtste finale' };

  // ---------- state ----------

  function defaultState() {
    return {
      config: {
        name: 'Padel Toernooi',
        players: Array.from({ length: 12 }, (_, i) => ({ id: uid(), name: `Speler ${i + 1}`, level: 5, active: true })),
        courts: [1, 2, 3].map(n => ({ id: uid(), name: `Baan ${n}` })),
        startTime: '19:00',
        endTime: '22:00',
        matchMinutes: 15,
        changeMinutes: 3,
        roundsOverride: null,
        poolMode: 'level',
        unknownTo: 'balance',
        poolCount: 2,
        koType: 'semi',
        koPairing: 'balanced',
        koMatchMinutes: 20,
        rankBy: 'total',
        levelMode: 'balanced',
      },
      schedule: null,
      knockout: null,
    };
  }

  function load(key = STORE_KEY) {
    try {
      const s = JSON.parse(localStorage.getItem(key));
      if (s && s.config) return normalize(s);
    } catch (e) { /* lege of kapotte opslag */ }
    return defaultState();
  }

  function normalize(s) {
    s.config = { ...defaultState().config, ...s.config };
    migrate(s);
    return s;
  }

  // Oudere opgeslagen toernooien omzetten naar het huidige formaat.
  function migrate(s) {
    s.config.players.forEach(p => { p.level = p.level <= 4 ? 3 : p.level >= 6 ? 7 : 5; });
    if (!s.config.poolMode) s.config.poolMode = 'level';
    delete s.config.usePools;
    if (s.schedule && !s.schedule.poolMode) s.schedule.poolMode = s.schedule.pools ? 'mixed' : 'none';
    if (s.knockout && !s.knockout.brackets) {
      s.knockout = { brackets: [{ poolId: null, name: 'Knock-out', seeds: s.knockout.seeds, rounds: s.knockout.rounds }] };
    }
  }

  let state = load();

  // Online schrijven alleen organisatoren: scores per wedstrijd, de rest gebundeld of in één keer.
  function save(opts = {}) {
    cache();
    if (!Cloud.canEdit()) return;
    if (opts.score) Cloud.saveScore(opts.score.id, opts.score.scoreA, opts.score.scoreB);
    else if (opts.full) Cloud.replaceAll(state);
    else Cloud.saveData(state);
  }

  function cache() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* opslag niet beschikbaar */ }
  }

  // Lokaal (of als online niet bereikbaar is) mag alles; online alleen als organisator.
  const editable = () => !Cloud.enabled || Cloud.status() === 'error' || Cloud.canEdit();

  // ---------- helpers ----------

  const toMin = t => {
    const [h, m] = String(t || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const fmt = min => {
    min = ((Math.round(min) % 1440) + 1440) % 1440;
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  };
  const hasScore = m => Number.isFinite(m.scoreA) && Number.isFinite(m.scoreB);

  function playerMap() {
    return new Map(state.config.players.map(p => [p.id, p]));
  }
  function pname(id, pm = playerMap()) {
    return pm.get(id)?.name ?? '(verwijderd)';
  }
  function courtName(id) {
    return state.config.courts.find(c => c.id === id)?.name ?? 'Baan ?';
  }
  function poolName(id) {
    return state.schedule?.pools?.find(p => p.id === id)?.name ?? '';
  }

  function poolSizes(n, k) {
    k = Math.max(1, k | 0);
    return Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
  }

  const usesPools = cfg => cfg.poolMode === 'level' || cfg.poolMode === 'mixed';

  // Twee aparte toernooien: beginners en gevorderden. "Weet ik niet" volgt de instelling unknownTo.
  function makeLevelPools(players, cfg) {
    const pools = [
      { id: 'BEG', name: 'Beginners', playerIds: [] },
      { id: 'ADV', name: 'Gevorderden', playerIds: [] },
    ];
    const isUnknown = p => levelInfo(p.level) === LEVELS[2];
    Scheduler.shuffle(players.slice())
      .sort((a, b) => isUnknown(a) - isUnknown(b))
      .forEach(p => addToLevelPool(pools, p, cfg));
    return pools;
  }

  function addToLevelPool(pools, p, cfg) {
    const L = levelInfo(p.level);
    let pool;
    if (L === LEVELS[0]) pool = pools[0];
    else if (L === LEVELS[1]) pool = pools[1];
    else if (cfg.unknownTo === 'beginner') pool = pools[0];
    else if (cfg.unknownTo === 'advanced') pool = pools[1];
    else pool = pools[0].playerIds.length <= pools[1].playerIds.length ? pools[0] : pools[1];
    pool.playerIds.push(p.id);
  }

  function poolSpec(cfg) {
    const active = cfg.players.filter(p => p.active !== false);
    if (cfg.poolMode === 'level') return makeLevelPools(active, cfg).map(p => ({ name: p.name, size: p.playerIds.length }));
    if (cfg.poolMode === 'mixed') {
      return poolSizes(active.length, cfg.poolCount).map((n, i) => ({ name: 'Poule ' + String.fromCharCode(65 + i), size: n }));
    }
    return [{ name: 'Alle spelers', size: active.length }];
  }

  // Grootste knock-out (in teams) die past bij het aantal spelers, begrensd door de instelling.
  function koTeamsFor(size, teams) {
    let t = teams;
    while (t > 1 && t * 2 > size) t /= 2;
    return t >= 2 ? t : 0;
  }

  // Knock-outs per poule (bij beginners/gevorderden) of één gezamenlijke. Finales vallen gelijk.
  function koPlan(cfg, spec) {
    const teams = KO_TEAMS[cfg.koType] || 0;
    if (!teams) return { brackets: [], stages: [], maxDepth: 0 };
    const brackets = cfg.poolMode === 'level'
      ? spec.map(p => ({ name: p.name, size: p.size, teams: koTeamsFor(p.size, teams) })).filter(b => b.teams)
      : [{ name: 'Knock-out', teams }];
    brackets.forEach(b => { b.depth = Math.log2(b.teams); });
    const maxDepth = Math.max(0, ...brackets.map(b => b.depth));
    const stages = [];
    for (let s = 0; s < maxDepth; s++) {
      let matches = 0;
      const names = new Set();
      brackets.forEach(b => {
        const r = s - (maxDepth - b.depth);
        if (r < 0) return;
        const t = b.teams / 2 ** r;
        matches += t / 2;
        names.add(KO_NAMES[t]);
      });
      stages.push({ name: [...names].join(' + '), matches });
    }
    return { brackets, stages, maxDepth, teams };
  }

  function plan(cfg) {
    const courts = cfg.courts.length;
    const active = cfg.players.filter(p => p.active !== false).length;
    let total = toMin(cfg.endTime) - toMin(cfg.startTime);
    if (total <= 0) total += 1440;
    const mm = +cfg.matchMinutes || 0;
    const ch = +cfg.changeMinutes || 0;
    const slot = mm + ch;
    const koMM = +cfg.koMatchMinutes || mm;
    const spec = poolSpec(cfg);
    const ko = koPlan(cfg, spec);
    const teams = ko.teams || 0;
    let koMinutes = 0;
    const koRounds = ko.stages.map(st => {
      const slots = Math.ceil(st.matches / Math.max(1, courts));
      koMinutes += slots * (koMM + ch);
      return { ...st, slots };
    });
    const sizes = spec.map(p => p.size);
    const perRound = Math.min(courts, sizes.reduce((s, n) => s + Math.floor(n / 4), 0));
    const autoRounds = slot > 0 ? Math.max(0, Math.floor((total - koMinutes + ch) / slot)) : 0;
    const rounds = cfg.roundsOverride > 0 ? +cfg.roundsOverride : autoRounds;
    const start = toMin(cfg.startTime);
    const koStart = start + rounds * slot;
    const used = rounds * slot + koMinutes - (rounds + koRounds.length > 0 ? ch : 0);
    const errors = [];
    const notes = [];

    if (active < 4) errors.push('Er zijn minimaal 4 aanwezige spelers nodig.');
    if (courts < 1) errors.push('Voeg minimaal één baan toe.');
    if (mm <= 0) errors.push('Een wedstrijd moet langer dan 0 minuten duren.');
    if (cfg.poolMode === 'mixed' && sizes.some(n => n < 4)) errors.push(`Met ${cfg.poolCount} poules zijn er poules met minder dan 4 spelers.`);
    if (cfg.poolMode === 'level') {
      spec.filter(p => p.size < 4).forEach(p => errors.push(
        `${p.name}: ${p.size} speler${p.size === 1 ? '' : 's'}. Een poule heeft minimaal 4 spelers nodig. Pas niveaus aan of kies waar “weet ik niet” speelt.`));
      ko.brackets.filter(b => b.teams < teams).forEach(b => notes.push({
        text: `${b.name}: met ${b.size} spelers begint de knock-out bij de ${KO_NAMES[b.teams].toLowerCase()} (top ${b.teams * 2}).`,
      }));
    } else if (teams * 2 > active) {
      errors.push(`De ${KO_NAMES[teams].toLowerCase()} vraagt ${teams * 2} spelers, er zijn er ${active}.`);
    }
    if (rounds < 1 && active >= 4) errors.push('Er is niet genoeg tijd voor één poulewedstrijd. Verleng de baantijd of verkort de wedstrijden.');
    if (used > total) notes.push({ warn: true, text: `Het schema duurt ${used - total} minuten langer dan de beschikbare baantijd.` });

    const resting = active - perRound * 4;
    if (resting > 0 && active >= 4) {
      notes.push({ text: `Per ronde rusten ${resting} speler${resting === 1 ? '' : 's'} (${perRound} ${perRound === 1 ? 'baan' : 'banen'} in gebruik). Rust wordt eerlijk verdeeld.` });
    }
    if (courts > perRound && active >= 4) {
      notes.push({ text: `${courts - perRound} ${courts - perRound === 1 ? 'baan blijft' : 'banen blijven'} per ronde ongebruikt door het aantal spelers.` });
    }
    const gamesPerPlayer = active ? (rounds * perRound * 4) / active : 0;

    return {
      total, slot, rounds, autoRounds, perRound, koRounds, koMinutes, koMM, start, koStart,
      end: start + used, used, active, sizes, spec, ko, gamesPerPlayer, errors, notes,
    };
  }

  function roundStart(i) {
    const p = plan(state.config);
    return p.start + i * p.slot;
  }

  // ---------- standings ----------

  function computeStandings(ids, roundLimit = Infinity) {
    const pm = playerMap();
    const stats = new Map(ids.map(id => [id, {
      id, name: pname(id, pm), level: pm.get(id)?.level ?? '-',
      played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, form: [],
    }]));
    (state.schedule?.rounds || []).forEach((r, ri) => {
      if (ri >= roundLimit) return;
      r.matches.forEach(m => {
        if (!hasScore(m)) return;
        const side = (team, f, a) => team.forEach(id => {
          const s = stats.get(id);
          if (!s) return;
          s.played++; s.gf += f; s.ga += a;
          const res = f > a ? 'W' : f < a ? 'V' : 'G';
          if (res === 'W') s.wins++; else if (res === 'V') s.losses++; else s.draws++;
          s.form.push(res);
        });
        side(m.teamA, m.scoreA, m.scoreB);
        side(m.teamB, m.scoreB, m.scoreA);
      });
    });
    const rows = [...stats.values()].map(s => ({
      ...s, diff: s.gf - s.ga, avg: s.played ? s.gf / s.played : 0, avgDiff: s.played ? (s.gf - s.ga) / s.played : 0,
    }));
    const byAvg = state.config.rankBy === 'avg';
    rows.sort((a, b) => byAvg
      ? b.avg - a.avg || b.avgDiff - a.avgDiff || b.gf - a.gf || a.name.localeCompare(b.name)
      : b.gf - a.gf || b.diff - a.diff || b.wins - a.wins || a.name.localeCompare(b.name));
    return rows;
  }

  function scheduledPlayerIds() {
    const ids = new Set();
    state.schedule?.rounds.forEach(r => {
      r.matches.forEach(m => [...m.teamA, ...m.teamB].forEach(id => ids.add(id)));
      r.resting.forEach(id => ids.add(id));
    });
    state.schedule?.pools?.forEach(p => p.playerIds.forEach(id => ids.add(id)));
    return [...ids].filter(id => playerMap().has(id));
  }

  function lastScoredRound() {
    let last = -1;
    state.schedule?.rounds.forEach((r, i) => { if (r.matches.some(hasScore)) last = i; });
    return last;
  }

  function standingsWithMovement(ids) {
    const rows = computeStandings(ids);
    const last = lastScoredRound();
    if (last > 0) {
      const prev = computeStandings(ids, last);
      const prevPos = new Map(prev.map((r, i) => [r.id, i]));
      rows.forEach((r, i) => { r.move = prevPos.get(r.id) - i; });
    }
    return rows;
  }

  // ---------- schedule ----------

  function generateSchedule(keepPlayed) {
    const cfg = state.config;
    const p = plan(cfg);
    if (p.errors.length) {
      alert('Kan geen schema maken:\n\n' + p.errors.join('\n'));
      return;
    }
    let kept = [];
    let pools = null;
    if (keepPlayed && state.schedule) {
      kept = state.schedule.rounds.slice(0, lastScoredRound() + 1);
      pools = state.schedule.pools;
      const poolsChanged = (state.schedule.poolMode || (pools ? 'mixed' : 'none')) !== cfg.poolMode
        || (cfg.poolMode === 'mixed' && (!pools || pools.length !== +cfg.poolCount));
      if (poolsChanged && kept.length) {
        alert('De poule-instellingen zijn gewijzigd sinds er gespeeld is. Maak een volledig nieuw schema om de poules opnieuw in te delen.');
        return;
      }
      if (poolsChanged) pools = null;
    } else if (state.schedule && state.schedule.rounds.some(r => r.matches.some(hasScore))) {
      if (!confirm('Er zijn al uitslagen ingevoerd. Een nieuw schema wist alle uitslagen. Doorgaan?')) return;
    }

    const players = cfg.players.filter(pl => pl.name.trim());
    const activePlayers = players.filter(pl => pl.active !== false);
    if (usesPools(cfg)) {
      if (!pools) {
        pools = cfg.poolMode === 'level'
          ? makeLevelPools(activePlayers, cfg)
          : Scheduler.makePools(activePlayers, +cfg.poolCount);
      } else {
        // Verwijderde spelers eruit; nieuwe spelers naar hun niveaupoule of de kleinste poule.
        const ids = new Set(players.map(pl => pl.id));
        pools = pools.map(pl => ({ ...pl, playerIds: pl.playerIds.filter(id => ids.has(id)) }));
        const inPool = new Set(pools.flatMap(pl => pl.playerIds));
        activePlayers.filter(pl => !inPool.has(pl.id)).forEach(pl => {
          if (cfg.poolMode === 'level') addToLevelPool(pools, pl, cfg);
          else pools.reduce((a, b) => (b.playerIds.length < a.playerIds.length ? b : a)).playerIds.push(pl.id);
        });
      }
    } else {
      pools = null;
    }

    const rounds = Scheduler.generateRounds({
      players, courts: cfg.courts, pools, keptRounds: kept,
      totalRounds: Math.max(p.rounds, kept.length), levelMode: cfg.levelMode,
    });
    state.schedule = { createdAt: Date.now(), poolMode: cfg.poolMode, pools, rounds };
    if (!keepPlayed) state.knockout = null;
    save({ full: true });
    renderAll();
    showTab('results');
  }

  // ---------- knock-out ----------

  function startKnockout() {
    const cfg = state.config;
    const teams = KO_TEAMS[cfg.koType];
    if (!teams || !state.schedule) return;
    const open = state.schedule.rounds.reduce((s, r) => s + r.matches.filter(m => !hasScore(m)).length, 0);
    if (open && !confirm(`Er zijn nog ${open} poulewedstrijden zonder uitslag. Toch de knock-out starten?`)) return;
    if (state.knockout && !confirm('De knock-out opnieuw indelen? Ingevoerde knock-outuitslagen gaan verloren.')) return;

    const activeIds = ids => ids.filter(id => playerMap().get(id)?.active !== false);
    const pools = state.schedule.pools;
    const brackets = [];
    if (state.schedule.poolMode === 'level' && pools) {
      // Elke niveaupoule speelt een eigen knock-out met de besten uit die poule.
      pools.forEach(pl => {
        const ranked = computeStandings(activeIds(pl.playerIds));
        const t = koTeamsFor(ranked.length, teams);
        if (t) brackets.push(buildBracket(pl.id, pl.name, ranked.slice(0, t * 2).map(r => r.id), t));
      });
    } else {
      const need = teams * 2;
      const overall = computeStandings(activeIds(scheduledPlayerIds()));
      let qualified;
      if (pools && pools.length) {
        const perPool = Math.floor(need / pools.length);
        const chosen = new Set();
        pools.forEach(pl => computeStandings(activeIds(pl.playerIds)).slice(0, perPool).forEach(r => chosen.add(r.id)));
        overall.forEach(r => { if (chosen.size < need) chosen.add(r.id); });
        qualified = overall.filter(r => chosen.has(r.id)).slice(0, need);
      } else {
        qualified = overall.slice(0, need);
      }
      if (qualified.length < need) {
        alert(`Niet genoeg spelers voor de knock-out (${qualified.length} van ${need}).`);
        return;
      }
      brackets.push(buildBracket(null, 'Knock-out', qualified.map(r => r.id), teams));
    }
    if (!brackets.length) {
      alert('Niet genoeg spelers voor een knock-out.');
      return;
    }
    state.knockout = { brackets };
    assignKoCourts();
    save();
    renderAll();
  }

  function buildBracket(poolId, name, seeds, teams) {
    const cfg = state.config;
    const need = teams * 2;
    const pairs = [];
    if (cfg.koPairing === 'balanced') {
      for (let i = 0; i < teams; i++) pairs.push([seeds[i], seeds[need - 1 - i]]);
    } else if (cfg.koPairing === 'top') {
      for (let i = 0; i < teams; i++) pairs.push([seeds[2 * i], seeds[2 * i + 1]]);
    } else {
      const s = Scheduler.shuffle(seeds.slice());
      for (let i = 0; i < teams; i++) pairs.push([s[2 * i], s[2 * i + 1]]);
    }
    const order = Scheduler.bracketOrder(teams);
    const rounds = [];
    for (let t = teams; t >= 2; t /= 2) {
      rounds.push({
        name: KO_NAMES[t],
        matches: Array.from({ length: t / 2 }, () => ({ id: uid(), teamA: null, teamB: null, scoreA: null, scoreB: null })),
      });
    }
    rounds[0].matches.forEach((m, i) => {
      m.teamA = pairs[order[2 * i]];
      m.teamB = pairs[order[2 * i + 1]];
    });
    return { poolId, name, seeds, rounds };
  }

  function koWinner(m) {
    if (!m.teamA || !m.teamB || !hasScore(m) || m.scoreA === m.scoreB) return null;
    return m.scoreA > m.scoreB ? m.teamA : m.teamB;
  }

  function bracketChampion(b) {
    return koWinner(b.rounds[b.rounds.length - 1].matches[0]);
  }

  function propagateKnockout() {
    const ko = state.knockout;
    if (!ko) return;
    ko.brackets.forEach(b => {
      for (let r = 0; r < b.rounds.length - 1; r++) {
        b.rounds[r].matches.forEach((m, i) => {
          const next = b.rounds[r + 1].matches[Math.floor(i / 2)];
          const side = i % 2 === 0 ? 'teamA' : 'teamB';
          const w = koWinner(m);
          if (String(next[side]) !== String(w)) {
            next[side] = w;
            if (next.scoreA != null || next.scoreB != null) {
              next.scoreA = null;
              next.scoreB = null;
              if (Cloud.canEdit()) Cloud.saveScore(next.id, null, null);
            }
          }
        });
      }
    });
    assignKoCourts();
  }

  // Alle knock-outs delen de banen; de finales worden gelijk gelegd.
  function assignKoCourts() {
    const ko = state.knockout;
    const p = plan(state.config);
    const courts = state.config.courts;
    const step = p.koMM + (+state.config.changeMinutes || 0);
    const depth = Math.max(...ko.brackets.map(b => b.rounds.length));
    let t = p.start + (state.schedule?.rounds.length || 0) * p.slot;
    for (let s = 0; s < depth; s++) {
      const matches = ko.brackets.flatMap(b => b.rounds[s - (depth - b.rounds.length)]?.matches || []);
      matches.forEach((m, i) => {
        m.courtId = courts[i % courts.length]?.id;
        m.time = t + Math.floor(i / courts.length) * step;
      });
      t += Math.ceil(matches.length / courts.length) * step;
    }
  }

  // ---------- tabs ----------

  function showTab(tab) {
    if (!['config', 'results', 'standings'].includes(tab)) tab = editable() ? 'config' : 'standings';
    if (tab === 'config' && !editable()) tab = 'standings';
    $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.body.dataset.tab = tab;
    if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
    if (tab === 'standings') { renderStandings(); celebrateLeader(); }
    if (tab === 'results') renderResults();
  }

  // ---------- configuratie ----------

  // Drie niveaus; intern een getal zodat het schema teams kan balanceren.
  const LEVELS = [
    { value: 3, label: 'Beginner', short: 'B', cls: 'lv-beg' },
    { value: 7, label: 'Gevorderd', short: 'G', cls: 'lv-adv' },
    { value: 5, label: 'Weet ik niet', short: '?', cls: 'lv-unk' },
  ];
  function levelInfo(l) {
    l = Number(l);
    return l <= 4 ? LEVELS[0] : l >= 6 ? LEVELS[1] : LEVELS[2];
  }
  function levelBadge(l) {
    const L = levelInfo(l);
    return `<i class="lv ${L.cls}" title="${L.label}">${L.short}</i>`;
  }
  function parseLevel(s) {
    s = s.trim().toLowerCase();
    if (/^[1-9]$/.test(s)) return levelInfo(+s).value;
    if (/^(b|beg|beginner|beginners|beginnend)$/.test(s)) return 3;
    if (/^(g|gev|gevorderd|gevorderde)$/.test(s)) return 7;
    if (/^(\?|onbekend|weet ik niet|weetikniet|x)$/.test(s)) return 5;
    return null;
  }

  function renderConfig() {
    const c = state.config;
    const active = c.players.filter(p => p.active !== false);
    const perPool = c.poolMode === 'level' ? ' per poule' : '';
    const counts = LEVELS.map(L => `${active.filter(p => levelInfo(p.level) === L).length} ${L.label.toLowerCase()}`).join(' · ');
    $('#tab-config').innerHTML = `
      <div class="grid">
        <div class="card span-2">
          <h2>Toernooi</h2>
          <label class="field">Naam
            <input type="text" data-field="name" value="${esc(c.name)}" maxlength="60">
          </label>
        </div>

        <div class="card span-2">
          <div class="card-head">
            <h2>Spelers <span class="pill">${active.length} aanwezig · ${counts}</span></h2>
            <div class="inline">
              <label class="field small">Aantal
                <input type="number" id="playerCount" min="0" max="80" value="${c.players.length}">
              </label>
              <button class="btn" data-action="apply-count">Pas aan</button>
            </div>
          </div>
          <table class="players">
            <thead><tr><th>#</th><th>Naam</th><th>Niveau</th><th title="Aanwezig">Aanwezig</th><th></th></tr></thead>
            <tbody>
              ${c.players.map((p, i) => `
                <tr data-pid="${p.id}" class="${p.active === false ? 'inactive' : ''}">
                  <td class="muted">${i + 1}</td>
                  <td><input type="text" data-pf="name" value="${esc(p.name)}" placeholder="Naam"></td>
                  <td>
                    <div class="seg" role="radiogroup" aria-label="Niveau">
                      ${LEVELS.map(L => `<label class="${L.cls} ${levelInfo(p.level) === L ? 'on' : ''}"><input type="radio" name="lv-${p.id}" data-pf="level" value="${L.value}" ${levelInfo(p.level) === L ? 'checked' : ''}>${L.label}</label>`).join('')}
                    </div>
                  </td>
                  <td><input type="checkbox" data-pf="active" ${p.active !== false ? 'checked' : ''}></td>
                  <td><button class="icon-btn" data-action="del-player" title="Verwijder">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
          <div class="row-actions">
            <button class="btn" data-action="add-player">+ Speler</button>
            <details class="bulk">
              <summary>Lijst plakken</summary>
              <p class="muted">Eén speler per regel, bijvoorbeeld <code>Sanne, gevorderd</code>, <code>Mark beginner</code> of <code>Joost ?</code>. Zonder niveau wordt het “weet ik niet”.</p>
              <textarea id="bulkPlayers" rows="6" placeholder="Sanne, gevorderd&#10;Mark, beginner&#10;Joost, ?"></textarea>
              <div class="inline">
                <button class="btn" data-action="bulk-replace">Vervang lijst</button>
                <button class="btn ghost" data-action="bulk-append">Voeg toe</button>
              </div>
            </details>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2>Banen</h2>
            <label class="field small">Aantal
              <input type="number" id="courtCount" min="1" max="30" value="${c.courts.length}">
            </label>
          </div>
          <div class="courts">
            ${c.courts.map((ct, i) => `
              <label class="court-input" data-cid="${ct.id}">
                <span class="muted">${i + 1}</span>
                <input type="text" data-cf="name" value="${esc(ct.name)}">
              </label>`).join('')}
          </div>
        </div>

        <div class="card">
          <h2>Tijd</h2>
          <div class="two">
            <label class="field">Banen beschikbaar vanaf<input type="time" data-field="startTime" value="${c.startTime}"></label>
            <label class="field">tot<input type="time" data-field="endTime" value="${c.endTime}"></label>
            <label class="field">Duur poulepotje (min)<input type="number" min="1" max="180" data-field="matchMinutes" data-num value="${c.matchMinutes}"></label>
            <label class="field">Wisseltijd (min)<input type="number" min="0" max="30" data-field="changeMinutes" data-num value="${c.changeMinutes}"></label>
            <label class="field">Aantal poulerondes
              <input type="number" min="0" max="100" data-field="roundsOverride" data-num value="${c.roundsOverride || ''}" placeholder="automatisch">
            </label>
          </div>
        </div>

        <div class="card">
          <h2>Poulefase</h2>
          <label class="field">Indeling
            <select data-field="poolMode">
              <option value="level" ${c.poolMode === 'level' ? 'selected' : ''}>Twee toernooien: beginners en gevorderden</option>
              <option value="mixed" ${c.poolMode === 'mixed' ? 'selected' : ''}>Gemengde poules, even sterk verdeeld</option>
              <option value="none" ${c.poolMode === 'none' ? 'selected' : ''}>Geen poules, iedereen speelt door elkaar</option>
            </select>
          </label>
          ${c.poolMode === 'level' ? `
            <p class="muted">Beginners en gevorderden spelen elk in een eigen poule en nooit tegen elkaar. Elke poule heeft een eigen ranglijst en een eigen knock-out.</p>
            <label class="field">Spelers met “weet ik niet” spelen bij
              <select data-field="unknownTo">
                <option value="balance" ${c.unknownTo === 'balance' ? 'selected' : ''}>De kleinste poule (poules even groot)</option>
                <option value="beginner" ${c.unknownTo === 'beginner' ? 'selected' : ''}>De beginners</option>
                <option value="advanced" ${c.unknownTo === 'advanced' ? 'selected' : ''}>De gevorderden</option>
              </select>
            </label>` : ''}
          ${c.poolMode === 'mixed' ? `
            <p class="muted">Spelers worden op niveau verdeeld zodat alle poules even sterk zijn. Je speelt alleen met en tegen spelers uit je eigen poule.</p>
            <label class="field">Aantal poules
              <input type="number" min="2" max="8" data-field="poolCount" data-num value="${c.poolCount}">
            </label>` : ''}
          <label class="field">Indeling teams per ronde
            <select data-field="levelMode">
              <option value="balanced" ${c.levelMode === 'balanced' ? 'selected' : ''}>Gelijkwaardige teams (aanbevolen)</option>
              <option value="similar" ${c.levelMode === 'similar' ? 'selected' : ''}>Spelen met spelers van eigen niveau</option>
              <option value="mixed" ${c.levelMode === 'mixed' ? 'selected' : ''}>Alles door elkaar</option>
            </select>
          </label>
          <label class="field">Ranglijst op basis van
            <select data-field="rankBy">
              <option value="total" ${c.rankBy === 'total' ? 'selected' : ''}>Totaal gewonnen games</option>
              <option value="avg" ${c.rankBy === 'avg' ? 'selected' : ''}>Gemiddeld gewonnen games per potje</option>
            </select>
          </label>
        </div>

        <div class="card">
          <h2>Knock-out</h2>
          <label class="field">Knock-outfase
            <select data-field="koType">
              <option value="none" ${c.koType === 'none' ? 'selected' : ''}>Geen knock-out</option>
              <option value="final" ${c.koType === 'final' ? 'selected' : ''}>Alleen finale (top 4 spelers${perPool})</option>
              <option value="semi" ${c.koType === 'semi' ? 'selected' : ''}>Halve finales + finale (top 8${perPool})</option>
              <option value="quarter" ${c.koType === 'quarter' ? 'selected' : ''}>Kwartfinales (top 16${perPool})</option>
              <option value="eighth" ${c.koType === 'eighth' ? 'selected' : ''}>Achtste finales (top 32${perPool})</option>
            </select>
          </label>
          <label class="field ${c.koType === 'none' ? 'disabled' : ''}">Teams vormen
            <select data-field="koPairing" ${c.koType === 'none' ? 'disabled' : ''}>
              <option value="balanced" ${c.koPairing === 'balanced' ? 'selected' : ''}>Nr. 1 + laatste, nr. 2 + één-na-laatste …</option>
              <option value="top" ${c.koPairing === 'top' ? 'selected' : ''}>Nr. 1 + 2, nr. 3 + 4 …</option>
              <option value="random" ${c.koPairing === 'random' ? 'selected' : ''}>Loting</option>
            </select>
          </label>
          <label class="field ${c.koType === 'none' ? 'disabled' : ''}">Duur knock-outpotje (min)
            <input type="number" min="1" max="180" data-field="koMatchMinutes" data-num value="${c.koMatchMinutes}" ${c.koType === 'none' ? 'disabled' : ''}>
          </label>
          <p class="muted">${{
            level: 'Beginners en gevorderden spelen elk een eigen knock-out met de besten uit hun poule. Is een poule te klein, dan begint die knock-out automatisch later (bijvoorbeeld alleen een finale). De finales worden tegelijk gespeeld.',
            mixed: 'Uit elke poule plaatsen de besten zich evenredig; eventuele resterende plekken gaan naar de beste overige spelers.',
            none: 'De best geplaatste spelers in de individuele ranglijst plaatsen zich.',
          }[c.poolMode]}</p>
        </div>

        <div class="card span-2 summary" id="planSummary"></div>
      </div>`;
    renderSummary();
  }

  function renderSummary() {
    const el = $('#planSummary');
    if (!el) return;
    const c = state.config;
    const p = plan(c);
    const hasSched = !!state.schedule;
    const played = hasSched && lastScoredRound() >= 0;
    el.innerHTML = `
      <h2>Planning</h2>
      <div class="stats">
        <div class="stat"><b>${p.total}</b><span>minuten baantijd</span></div>
        <div class="stat"><b>${p.rounds}</b><span>poulerondes${c.roundsOverride ? '' : ' (auto)'}</span></div>
        <div class="stat"><b>${p.perRound}</b><span>potjes per ronde</span></div>
        <div class="stat"><b>${p.gamesPerPlayer.toFixed(1)}</b><span>potjes per speler</span></div>
        <div class="stat"><b>${fmt(p.end)}</b><span>verwachte eindtijd</span></div>
      </div>
      <ul class="timeline">
        ${p.rounds ? `<li><b>${fmt(p.start)} – ${fmt(p.start + p.rounds * p.slot - (+c.changeMinutes || 0))}</b> Poulefase: ${p.rounds} rondes van ${c.matchMinutes} min + ${c.changeMinutes} min wissel${usesPools(c) ? ` · ${p.spec.map(x => `${esc(x.name)} ${x.size}`).join(' · ')} spelers` : ''}</li>` : ''}
        ${(() => {
          let t = p.koStart;
          return p.koRounds.map(r => {
            const s = t;
            t += r.slots * (p.koMM + (+c.changeMinutes || 0));
            return `<li><b>${fmt(s)}</b> ${r.name}: ${r.matches} potje${r.matches === 1 ? '' : 's'}${r.slots > 1 ? ` in ${r.slots} blokken` : ''}</li>`;
          }).join('');
        })()}
      </ul>
      ${p.errors.map(e => `<div class="alert error">${esc(e)}</div>`).join('')}
      ${p.notes.map(n => `<div class="alert ${n.warn ? 'warn' : 'info'}">${esc(n.text)}</div>`).join('')}
      <div class="row-actions">
        <button class="btn primary" data-action="generate" ${p.errors.length ? 'disabled' : ''}>${hasSched ? 'Nieuw schema maken' : 'Schema maken'}</button>
        ${played ? '<button class="btn" data-action="replan">Herplan open rondes (houdt uitslagen)</button>' : ''}
        ${hasSched ? `<span class="muted">Huidig schema: ${state.schedule.rounds.length} rondes${state.schedule.pools ? ', ' + state.schedule.pools.length + ' poules' : ''}.</span>` : ''}
      </div>
      ${played ? '<p class="muted">Speler afwezig of erbij gekomen? Pas de aanwezigheid aan en kies “Herplan open rondes”: gespeelde rondes blijven staan en de rest wordt opnieuw ingedeeld.</p>' : ''}`;
  }

  function parseBulk(text) {
    return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      const sep = l.match(/^(.*)[,;:\t](.*)$/);
      if (sep && parseLevel(sep[2]) != null) return { name: sep[1].trim(), level: parseLevel(sep[2]) };
      const word = l.match(/^(.*?)\s+(\S+)$/);
      if (word && parseLevel(word[2]) != null) return { name: word[1].trim(), level: parseLevel(word[2]) };
      return { name: sep ? sep[1].trim() : l, level: 5 };
    }).map(p => ({ id: uid(), name: p.name, level: p.level, active: true }));
  }

  function setupConfigEvents() {
    const root = $('#tab-config');

    root.addEventListener('input', e => {
      const t = e.target;
      const c = state.config;
      if (t.dataset.field) {
        let v = t.type === 'checkbox' ? t.checked : t.value;
        if ('num' in t.dataset) v = v === '' ? null : Number(v);
        c[t.dataset.field] = v;
        if (t.dataset.field === 'name') $('#brandName').textContent = v || 'Padel Toernooi';
      } else if (t.dataset.pf) {
        const p = c.players.find(x => x.id === t.closest('tr').dataset.pid);
        if (!p) return;
        if (t.dataset.pf === 'level') {
          p.level = +t.value;
          $$('label', t.closest('.seg')).forEach(lb => lb.classList.toggle('on', lb.contains(t)));
        } else if (t.dataset.pf === 'active') {
          p.active = t.checked;
          t.closest('tr').classList.toggle('inactive', !t.checked);
        } else {
          p.name = t.value;
        }
      } else if (t.dataset.cf) {
        const ct = c.courts.find(x => x.id === t.closest('[data-cid]').dataset.cid);
        if (ct) ct.name = t.value;
      } else {
        return;
      }
      save();
      renderSummary();
    });

    root.addEventListener('change', e => {
      const t = e.target;
      const c = state.config;
      if (t.id === 'courtCount') {
        const n = Math.max(1, Math.min(30, +t.value || 1));
        while (c.courts.length < n) c.courts.push({ id: uid(), name: `Baan ${c.courts.length + 1}` });
        c.courts.length = n;
        save();
        renderConfig();
      } else if (['poolMode', 'koType', 'rankBy'].includes(t.dataset.field) || t.dataset.pf === 'active') {
        renderConfig();
      }
    });

    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const c = state.config;
      const a = btn.dataset.action;
      if (a === 'add-player') {
        c.players.push({ id: uid(), name: `Speler ${c.players.length + 1}`, level: 5, active: true });
      } else if (a === 'del-player') {
        const id = btn.closest('tr').dataset.pid;
        c.players = c.players.filter(p => p.id !== id);
      } else if (a === 'apply-count') {
        const n = Math.max(0, Math.min(80, +$('#playerCount').value || 0));
        if (n < c.players.length && !confirm(`De laatste ${c.players.length - n} speler(s) verwijderen?`)) return;
        while (c.players.length < n) c.players.push({ id: uid(), name: `Speler ${c.players.length + 1}`, level: 5, active: true });
        c.players.length = n;
      } else if (a === 'bulk-replace' || a === 'bulk-append') {
        const list = parseBulk($('#bulkPlayers').value);
        if (!list.length) return;
        c.players = a === 'bulk-replace' ? list : c.players.concat(list);
      } else if (a === 'generate') {
        generateSchedule(false);
        return;
      } else if (a === 'replan') {
        generateSchedule(true);
        return;
      } else {
        return;
      }
      save();
      renderConfig();
      if (a === 'add-player') {
        const inputs = $$('#tab-config tbody input[data-pf="name"]');
        inputs[inputs.length - 1]?.select();
      }
    });
  }

  // ---------- uitslagen ----------

  let hideDone = false;

  function teamHtml(team, pm, cls = '') {
    if (!team) return `<div class="team ${cls} tbd">nog onbekend</div>`;
    return `<div class="team ${cls}">
      ${team.map(id => `<span class="pn">${esc(pname(id, pm))} ${levelBadge(pm.get(id)?.level)}</span>`).join('')}
    </div>`;
  }

  function matchHtml(m, kind, extra = '') {
    const pm = playerMap();
    const scored = hasScore(m);
    const win = scored ? (m.scoreA > m.scoreB ? 'a' : m.scoreA < m.scoreB ? 'b' : 'draw') : '';
    const disabled = !editable() || (kind === 'ko' && (!m.teamA || !m.teamB));
    const tie = kind === 'ko' && scored && m.scoreA === m.scoreB;
    return `
      <div class="match ${scored ? 'scored' : ''} win-${win} ${tie ? 'tie' : ''}" data-mid="${m.id}" data-kind="${kind}">
        <div class="court">${esc(courtName(m.courtId))}${m.pool ? ` <span class="pool-tag">${esc(poolName(m.pool))}</span>` : ''}${extra}</div>
        ${teamHtml(m.teamA, pm, 'a')}
        <div class="score-box">
          <input class="score" type="number" min="0" max="99" inputmode="numeric" data-side="A" value="${m.scoreA ?? ''}" ${disabled ? 'disabled' : ''} aria-label="Games team 1">
          <span>–</span>
          <input class="score" type="number" min="0" max="99" inputmode="numeric" data-side="B" value="${m.scoreB ?? ''}" ${disabled ? 'disabled' : ''} aria-label="Games team 2">
        </div>
        ${teamHtml(m.teamB, pm, 'b')}
        ${tie ? '<div class="tie-msg">Een knock-outpotje heeft een winnaar nodig.</div>' : ''}
      </div>`;
  }

  function renderResults() {
    const el = $('#tab-results');
    const s = state.schedule;
    if (!s) {
      el.innerHTML = editable()
        ? `<div class="empty card"><h2>Nog geen schema</h2><p>Stel het toernooi in en klik op <b>Schema maken</b>.</p>
          <button class="btn primary" data-goto="config">Naar configuratie</button></div>`
        : '<div class="empty card"><h2>Nog geen schema</h2><p>Het speelschema verschijnt hier zodra de organisatie het heeft gemaakt.</p></div>';
      return;
    }
    const pm = playerMap();
    const cfg = state.config;
    const all = s.rounds.flatMap(r => r.matches);
    const done = all.filter(hasScore).length;
    const koTeams = KO_TEAMS[cfg.koType];
    el.innerHTML = `
      <div class="toolbar card">
        <div><b id="progressText">${done} / ${all.length}</b> poulepotjes ingevuld</div>
        <div class="progress"><div style="width:${all.length ? (done / all.length) * 100 : 0}%"></div></div>
        <label class="switch"><input type="checkbox" id="hideDone" ${hideDone ? 'checked' : ''}><span>Verberg afgeronde rondes</span></label>
        <button class="btn ghost" data-action="print">Print schema</button>
      </div>
      ${s.pools ? `<div class="card pools">${s.pools.map(p => `<div><h3>${esc(p.name)}</h3><p>${p.playerIds.map(id => esc(pname(id, pm))).join(', ')}</p></div>`).join('')}</div>` : ''}
      <div class="rounds">
        ${s.rounds.map((r, i) => {
          const complete = r.matches.length && r.matches.every(hasScore);
          const t = roundStart(i);
          return `
            <section class="round ${complete ? 'complete' : ''} ${complete && hideDone ? 'hidden' : ''}" data-round="${i}">
              <header>
                <h3>Ronde ${i + 1}</h3>
                <span class="time">${fmt(t)} – ${fmt(t + (+cfg.matchMinutes || 0))}</span>
                <span class="badge">${complete ? '✓ compleet' : `${r.matches.filter(hasScore).length}/${r.matches.length}`}</span>
              </header>
              <div class="matches">${r.matches.map(m => matchHtml(m, 'pool')).join('')}</div>
              ${r.resting.length ? `<div class="resting">Rust: ${r.resting.map(id => esc(pname(id, pm))).join(', ')}</div>` : ''}
            </section>`;
        }).join('')}
      </div>
      ${koTeams ? `
        <section class="card ko-section">
          <div class="card-head">
            <h2>Knock-out</h2>
            ${editable() ? `<button class="btn ${state.knockout ? 'ghost' : 'primary'}" data-action="start-ko">${state.knockout ? 'Opnieuw indelen' : 'Start knock-out'}</button>` : ''}
          </div>
          ${state.knockout
            ? state.knockout.brackets.map(b => `
                ${state.knockout.brackets.length > 1 ? `<h2 class="bracket-name">${esc(b.name)}</h2>` : ''}
                ${b.rounds.map(r => `
                  <h3>${r.name}</h3>
                  <div class="matches">${r.matches.map(m => matchHtml(m, 'ko', m.time != null ? ` <span class="pool-tag">${fmt(m.time)}</span>` : '')).join('')}</div>`).join('')}`).join('')
            : `<p class="muted">${koIntro()}</p>`}
        </section>` : ''}`;
  }

  function koIntro() {
    const ko = plan(state.config).ko;
    if (state.schedule?.poolMode === 'level') {
      return 'Als de poulefase klaar is, start je hier de knock-outs. Per poule gaan de besten door naar hun eigen knock-out: '
        + ko.brackets.map(b => `${esc(b.name)} top ${b.teams * 2}`).join(', ') + '.';
    }
    return `Als de poulefase klaar is, start je hier de knock-out. De top ${ko.teams * 2} spelers vormen ${ko.teams} teams.`;
  }

  function findMatch(mid, kind) {
    if (kind === 'ko') {
      for (const b of state.knockout?.brackets || []) {
        for (const r of b.rounds) {
          const m = r.matches.find(x => x.id === mid);
          if (m) return { m };
        }
      }
    } else {
      for (const [ri, r] of (state.schedule?.rounds || []).entries()) {
        const m = r.matches.find(x => x.id === mid);
        if (m) return { m, ri };
      }
    }
    return {};
  }

  function setupResultsEvents() {
    const root = $('#tab-results');

    root.addEventListener('input', e => {
      const t = e.target;
      if (t.id === 'hideDone') {
        hideDone = t.checked;
        $$('.round.complete', root).forEach(r => r.classList.toggle('hidden', hideDone));
        return;
      }
      if (!t.classList.contains('score')) return;
      const box = t.closest('.match');
      const { m, ri } = findMatch(box.dataset.mid, box.dataset.kind);
      if (!m) return;
      const v = t.value === '' ? null : Math.max(0, Math.min(99, Math.round(+t.value)));
      m['score' + t.dataset.side] = Number.isFinite(v) ? v : null;
      save({ score: m });
      // Licht bijwerken zodat de focus in het invoerveld blijft.
      const scored = hasScore(m);
      box.classList.toggle('scored', scored);
      box.classList.remove('win-a', 'win-b', 'win-draw');
      if (scored) box.classList.add(m.scoreA > m.scoreB ? 'win-a' : m.scoreA < m.scoreB ? 'win-b' : 'win-draw');
      if (ri != null) {
        const r = state.schedule.rounds[ri];
        const sec = box.closest('.round');
        const complete = r.matches.every(hasScore);
        sec.classList.toggle('complete', complete);
        $('.badge', sec).textContent = complete ? '✓ compleet' : `${r.matches.filter(hasScore).length}/${r.matches.length}`;
        const all = state.schedule.rounds.flatMap(x => x.matches);
        const done = all.filter(hasScore).length;
        $('#progressText').textContent = `${done} / ${all.length}`;
        $('.toolbar .progress div').style.width = (done / all.length) * 100 + '%';
      }
    });

    root.addEventListener('change', e => {
      const t = e.target;
      if (t.classList.contains('score') && t.closest('.match').dataset.kind === 'ko') {
        propagateKnockout();
        save();
        const id = t.closest('.match').dataset.mid;
        const side = t.dataset.side;
        renderResults();
        // Focus naar het volgende veld na het hertekenen.
        const inputs = $$('.score:not([disabled])', root);
        const idx = inputs.findIndex(i => i.closest('.match').dataset.mid === id && i.dataset.side === side);
        if (document.activeElement === document.body && idx >= 0) inputs[idx + 1]?.focus();
      }
    });

    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.classList.contains('score')) {
        const inputs = $$('.round:not(.hidden) .score, .ko-section .score:not([disabled])', root);
        const i = inputs.indexOf(e.target);
        inputs[i + 1]?.focus();
        inputs[i + 1]?.select();
        e.preventDefault();
      }
    });

    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'start-ko') startKnockout();
      if (btn.dataset.action === 'print') window.print();
    });
  }

  // ---------- tussenstand ----------

  let standingsView = 'all';
  let beamerTimer = null;

  // Bij beginners/gevorderden is er geen gezamenlijke ranglijst: elke poule is een eigen toernooi.
  function standingsViews() {
    const s = state.schedule;
    const separate = s?.poolMode === 'level';
    const views = separate ? [] : [{ id: 'all', name: 'Totaal', ids: scheduledPlayerIds() }];
    s?.pools?.forEach(p => views.push({ id: p.id, name: p.name, ids: p.playerIds }));
    return views;
  }

  function currentView() {
    const views = standingsViews();
    if (!views.some(v => v.id === standingsView)) standingsView = views[0].id;
    return views.find(v => v.id === standingsView);
  }

  function viewBrackets(view) {
    const brackets = state.knockout?.brackets || [];
    return state.schedule?.poolMode === 'level' ? brackets.filter(b => b.poolId === view.id) : brackets;
  }

  function renderStandings() {
    const el = $('#tab-standings');
    const s = state.schedule;
    const cfg = state.config;
    if (!s) {
      el.innerHTML = `<div class="arena-wrap"><div class="arena">${STRIPES}<div class="sparkles"></div><div class="arena-empty">
        <div class="ball">🎾</div><h1>${esc(cfg.name)}</h1><p>De tussenstand verschijnt zodra het schema klaar is.</p></div></div></div>`;
      return;
    }
    const views = standingsViews();
    const view = currentView();
    const separate = s.poolMode === 'level';
    const rows = standingsWithMovement(view.ids);
    const all = s.rounds.flatMap(r => r.matches).filter(m => !separate || m.pool === view.id);
    const done = all.filter(hasScore).length;
    let last = -1;
    s.rounds.forEach((r, i) => { if (r.matches.some(m => hasScore(m) && (!separate || m.pool === view.id))) last = i; });
    const byAvg = cfg.rankBy === 'avg';
    const metric = r => (byAvg ? r.avg.toFixed(2) : r.gf);
    const metricLabel = byAvg ? 'gem. games' : 'games';
    const pm = playerMap();
    const brackets = viewBrackets(view);
    const champions = brackets.map(b => {
      const w = bracketChampion(b);
      return w && { label: b.poolId ? `Winnaars ${b.name}` : 'Winnaars knock-out', names: w.map(id => pname(id, pm)).join(' & ') };
    }).filter(Boolean);
    const champion = brackets.length > 0 && champions.length === brackets.length;

    const podium = rows.slice(0, 3);
    const podiumOrder = [1, 0, 2].filter(i => podium[i]);
    const status = champion ? 'Eindstand'
      : done === 0 ? 'Nog geen uitslagen'
      : done === all.length ? 'Poulefase afgerond'
      : `Tussenstand na ronde ${last + 1} van ${s.rounds.length}`;

    el.innerHTML = `
      <div class="arena-wrap"><div class="arena ${BEAMER ? 'big' : ''}">
        ${STRIPES}
        <div class="sparkles"></div>
        <canvas id="confetti"></canvas>
        <header class="arena-head">
          <div>
            <img class="arena-logo" src="img/boor-logo-wit.png" alt="BOOR – kwaliteit in onderwijs">
            <div class="eyebrow">${esc(status)}</div>
            <h1 class="shine">${esc(cfg.name)}</h1>
          </div>
          <div class="arena-progress">
            <div class="ring" style="--p:${all.length ? (done / all.length) * 100 : 0}">
              <span>${all.length ? Math.round((done / all.length) * 100) : 0}%</span>
            </div>
            <small>${done} van ${all.length} potjes</small>
          </div>
        </header>

        ${views.length > 1 ? `<nav class="chips">${views.map(v => `<button class="chip ${v.id === standingsView ? 'on' : ''}" data-view="${v.id}">${esc(v.name)}</button>`).join('')}</nav>` : ''}

        ${champions.map(c => `<div class="champion"><span class="trophy">🏆</span><div><small>${esc(c.label)}</small><b>${esc(c.names)}</b></div></div>`).join('')}

        <div class="arena-grid">
          <div class="main-col">
            ${done ? `
            <div class="podium">
              ${podiumOrder.map(i => {
                const r = podium[i];
                return `<div class="step step-${i + 1}" style="--d:${i * 120}ms">
                  <div class="medal">${['🥇', '🥈', '🥉'][i]}</div>
                  ${i === 0 ? '<div class="crown">👑</div>' : ''}
                  <div class="pod-name">${esc(r.name)}</div>
                  <div class="pod-val">${metric(r)}<small>${metricLabel}</small></div>
                  <div class="block">${i + 1}</div>
                </div>`;
              }).join('')}
            </div>` : ''}

            <table class="ranking">
              <thead><tr>
                <th>#</th><th></th><th class="left">Speler</th><th title="Niveau">Nv</th><th title="Gespeeld">P</th>
                <th title="Gewonnen potjes">W</th><th title="Games voor" class="${byAvg ? '' : 'hl'}">Games</th>
                <th title="Games tegen">Tegen</th><th title="Saldo">+/-</th><th title="Gemiddeld per potje" class="${byAvg ? 'hl' : ''}">Gem.</th><th class="form-col">Vorm</th>
              </tr></thead>
              <tbody>
                ${rows.map((r, i) => `
                  <tr class="${i < 3 && done ? 'top top-' + (i + 1) : ''}" style="--d:${Math.min(i, 20) * 35}ms">
                    <td class="pos">${i + 1}</td>
                    <td class="move">${r.move > 0 ? `<span class="up">▲${r.move}</span>` : r.move < 0 ? `<span class="down">▼${-r.move}</span>` : ''}</td>
                    <td class="left name">${esc(r.name)}</td>
                    <td>${levelBadge(r.level)}</td>
                    <td>${r.played}</td>
                    <td>${r.wins}</td>
                    <td class="${byAvg ? '' : 'hl'}"><b>${r.gf}</b></td>
                    <td>${r.ga}</td>
                    <td class="${r.diff > 0 ? 'pos-diff' : r.diff < 0 ? 'neg-diff' : ''}">${r.diff > 0 ? '+' : ''}${r.diff}</td>
                    <td class="${byAvg ? 'hl' : ''}">${r.avg.toFixed(1)}</td>
                    <td class="form-col">${r.form.slice(-5).map(f => `<span class="dot ${f}" title="${f === 'W' ? 'Gewonnen' : f === 'V' ? 'Verloren' : 'Gelijk'}"></span>`).join('')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>

          <aside class="side-col">
            ${brackets.length ? bracketHtml(pm, brackets) : ''}
            ${nextUpHtml(pm)}
            ${recentHtml(pm, separate ? view.id : null)}
          </aside>
        </div>
        ${BEAMER ? '' : '<div class="arena-actions"><button class="btn glow" data-action="confetti">🎉 Feest!</button><a class="btn glow" href="?beamer#standings" target="_blank">📺 Beamerweergave</a></div>'}
      </div></div>`;
  }

  // BOOR-bordwisserstrepen (stijlelement uit de huisstijl), minimaal 3 strepen zichtbaar.
  const STRIPES = `
    <svg class="stripes" viewBox="0 0 300 220" aria-hidden="true">
      <g transform="skewX(-12)">
        <rect class="s1" x="70" y="46" width="58" height="200" rx="26"/>
        <rect class="s2" x="132" y="14" width="58" height="220" rx="26"/>
        <rect class="s3" x="194" y="34" width="58" height="210" rx="26"/>
        <rect class="s4" x="256" y="4" width="58" height="230" rx="26"/>
      </g>
    </svg>`;

  function bracketHtml(pm, brackets) {
    const team = t => (t ? t.map(id => esc(pname(id, pm))).join(' & ') : '<i class="muted">nog onbekend</i>');
    return brackets.map(b => `
      <div class="panel">
        <h3>🏟️ Knock-out${b.poolId ? ` · ${esc(b.name)}` : ''}</h3>
        <div class="bracket">
          ${b.rounds.map(r => `
            <div class="b-round">
              <div class="b-title">${r.name}</div>
              ${r.matches.map(m => {
                const w = koWinner(m);
                return `<div class="b-match">
                  <div class="${w && w === m.teamA ? 'won' : ''}"><span>${team(m.teamA)}</span><b>${m.scoreA ?? ''}</b></div>
                  <div class="${w && w === m.teamB ? 'won' : ''}"><span>${team(m.teamB)}</span><b>${m.scoreB ?? ''}</b></div>
                </div>`;
              }).join('')}
            </div>`).join('')}
        </div>
      </div>`).join('');
  }

  function nextUpHtml(pm) {
    const s = state.schedule;
    const team = t => t.map(id => esc(pname(id, pm))).join(' & ');
    const ri = s.rounds.findIndex(r => r.matches.some(m => !hasScore(m)));
    if (ri >= 0) {
      const r = s.rounds[ri];
      return `<div class="panel">
        <h3>⚡ Nu op de baan · Ronde ${ri + 1} <small>${fmt(roundStart(ri))}</small></h3>
        ${r.matches.filter(m => !hasScore(m)).map(m => `
          <div class="now-match"><div class="now-court">${esc(courtName(m.courtId))}</div>
          <div>${team(m.teamA)} <span class="vs">vs</span> ${team(m.teamB)}</div></div>`).join('')}
        ${r.resting.length ? `<div class="now-rest">Rust: ${r.resting.map(id => esc(pname(id, pm))).join(', ')}</div>` : ''}
      </div>`;
    }
    const brackets = state.knockout?.brackets || [];
    const koMatch = brackets.flatMap(b => b.rounds.flatMap(r => r.matches.map(m => ({
      ...m, round: b.poolId ? `${r.name} ${b.name.toLowerCase()}` : r.name,
    })))).filter(m => m.teamA && m.teamB && !koWinner(m));
    if (koMatch.length) {
      return `<div class="panel"><h3>⚡ Nu op de baan · Knock-out</h3>
        ${koMatch.map(m => `<div class="now-match"><div class="now-court">${esc(courtName(m.courtId))}</div>
          <div><small class="now-round">${esc(m.round)}${m.time != null ? ` · ${fmt(m.time)}` : ''}</small><br>${team(m.teamA)} <span class="vs">vs</span> ${team(m.teamB)}</div></div>`).join('')}</div>`;
    }
    return '';
  }

  function recentHtml(pm, poolId) {
    const list = [];
    state.schedule.rounds.forEach((r, ri) => r.matches.forEach(m => {
      if (hasScore(m) && (!poolId || m.pool === poolId)) list.push({ m, ri });
    }));
    const recent = list.slice(-6).reverse();
    if (!recent.length) return '';
    const team = t => t.map(id => esc(pname(id, pm))).join(' & ');
    return `<div class="panel">
      <h3>📣 Laatste uitslagen</h3>
      ${recent.map(({ m, ri }) => `
        <div class="recent">
          <small>R${ri + 1}</small>
          <span class="${m.scoreA > m.scoreB ? 'won' : ''}">${team(m.teamA)}</span>
          <b>${m.scoreA}–${m.scoreB}</b>
          <span class="${m.scoreB > m.scoreA ? 'won' : ''}">${team(m.teamB)}</span>
        </div>`).join('')}
    </div>`;
  }

  function celebrateLeader() {
    if (!state.schedule || lastScoredRound() < 0) return;
    const view = currentView();
    const leader = computeStandings(view.ids)[0];
    if (!leader || !leader.played) return;
    const key = LEADER_KEY + ':' + view.id;
    let prev = null;
    try { prev = localStorage.getItem(key); } catch (e) { /* geen opslag */ }
    if (prev !== leader.id) {
      try { localStorage.setItem(key, leader.id); } catch (e) { /* geen opslag */ }
      if (prev) setTimeout(confetti, 400);
    }
  }

  function confetti() {
    const canvas = $('#confetti');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = (canvas.width = canvas.offsetWidth);
    const H = (canvas.height = canvas.offsetHeight);
    const colors = ['#c70a64', '#0090ad', '#e9bfd1', '#fac075', '#b0ddae', '#f0e67b', '#ffffff'];
    const parts = Array.from({ length: 220 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.3,
      y: H * 0.25,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 14 - 4,
      s: 4 + Math.random() * 6,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    let frame = 0;
    (function tick() {
      ctx.clearRect(0, 0, W, H);
      parts.forEach(p => {
        p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      if (++frame < 220) requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W, H);
    })();
  }

  function setupStandingsEvents() {
    const root = $('#tab-standings');
    root.addEventListener('click', e => {
      const chip = e.target.closest('[data-view]');
      if (chip) {
        standingsView = chip.dataset.view;
        renderStandings();
      }
      const btn = e.target.closest('[data-action="confetti"]');
      if (btn) confetti();
    });
  }

  // ---------- import / export ----------

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.config.name || 'toernooi').replace(/[^\w-]+/g, '_') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const s = JSON.parse(reader.result);
        if (!s.config) throw new Error('geen toernooibestand');
        s.config = { ...defaultState().config, ...s.config };
        state = normalize(s);
        save({ full: true });
        renderAll();
      } catch (err) {
        alert('Dit bestand kon niet worden geladen: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------- init ----------

  let errorShown = false;
  let uploadAsked = false;

  // Herteken na een wijziging van buitenaf zonder de invoer onder je vingers weg te halen.
  function refresh() {
    const tab = document.body.dataset.tab;
    $('#brandName').textContent = state.config.name || 'Padel Toernooi';
    if (tab === 'standings') { renderStandings(); celebrateLeader(); }
    else if (tab === 'results' && !document.activeElement?.classList.contains('score')) renderResults();
    else if (tab === 'config' && !$('#tab-config').contains(document.activeElement)) renderConfig();
  }

  // Eerste keer online als organisator: het toernooi uit deze browser meenemen?
  function offerUpload() {
    if (uploadAsked) return;
    uploadAsked = true;
    const hasLocal = (() => { try { return !!localStorage.getItem(LOCAL_KEY); } catch (e) { return false; } })();
    if (hasLocal && confirm('Er staat nog geen toernooi online. Wil je het toernooi uit deze browser online zetten?')) {
      state = load(LOCAL_KEY);
    }
    save({ full: true });
    renderAll();
  }

  function renderCloud() {
    const bar = $('#cloudBar');
    document.body.classList.toggle('viewer', !editable());
    if (!Cloud.enabled) { bar.innerHTML = ''; return; }
    const st = Cloud.status();
    const u = Cloud.user();
    const dot = st === 'live' ? '<span class="dot-live"></span>Live' : st === 'error' ? '⚠️ Offline' : 'Verbinden…';
    bar.innerHTML = `<span class="cloud-state" title="${st === 'error' ? 'Online toernooi niet bereikbaar; je werkt lokaal in deze browser.' : 'Wijzigingen zijn direct voor iedereen zichtbaar.'}">${dot}</span>`
      + (st === 'error' ? ''
        : u ? `<span class="cloud-user" title="${esc(u.email)}">${Cloud.canEdit() ? 'Organisator' : 'Kijker'}</span><button class="btn ghost small" data-action="signout">Uitloggen</button>`
        : '<button class="btn small" data-action="signin">Inloggen organisator</button>');
  }

  function renderAll() {
    $('#brandName').textContent = state.config.name || 'Padel Toernooi';
    document.title = state.config.name || 'Padel Toernooi';
    renderConfig();
    renderResults();
    renderStandings();
  }

  function init() {
    if (BEAMER) document.body.classList.add('beamer');
    setupConfigEvents();
    setupResultsEvents();
    setupStandingsEvents();

    $('.tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (b) showTab(b.dataset.tab);
    });
    document.addEventListener('click', e => {
      const g = e.target.closest('[data-goto]');
      if (g) showTab(g.dataset.goto);
    });
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', () => $('#fileImport').click());
    $('#fileImport').addEventListener('change', e => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('#btnReset').addEventListener('click', () => {
      if (!confirm('Alles wissen en opnieuw beginnen? Exporteer eerst als je het toernooi wilt bewaren.')) return;
      state = defaultState();
      save({ full: true });
      renderAll();
      showTab('config');
    });

    // Een ander tabblad (bijv. de beamer) volgt wijzigingen live.
    window.addEventListener('storage', e => {
      if (e.key !== STORE_KEY || Cloud.enabled) return;
      state = load();
      refresh();
    });

    $('#cloudBar').addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'signin') Cloud.signIn();
      if (a === 'signout') Cloud.signOut();
    });

    Cloud.init({
      onData({ data, scores, own }) {
        if (!own) state = data ? normalize(data) : (Cloud.canEdit() ? state : defaultState());
        Cloud.applyScores(state, scores);
        cache();
        renderCloud();
        refresh();
        if (!data && Cloud.canEdit()) offerUpload();
      },
      onAuth() {
        renderCloud();
        renderAll();
        showTab(document.body.dataset.tab);
        if (Cloud.canEdit() && Cloud.remoteEmpty()) offerUpload();
      },
      onDenied(email) {
        alert(`Je bent ingelogd als ${email}, maar dit account mag het toernooi niet wijzigen. Je kunt wel meekijken.`);
      },
      onStatus() {
        renderCloud();
        renderAll();
      },
      onError(e) {
        if (!errorShown) alert('Opslaan online is mislukt: ' + (e.message || e) + '\nControleer je internetverbinding.');
        errorShown = true;
      },
    });

    renderCloud();
    renderAll();
    const startTab = location.hash.slice(1)
      || (Cloud.enabled ? 'standings' : state.schedule ? 'results' : 'config');
    showTab(BEAMER ? 'standings' : startTab);

    if (BEAMER) {
      // Wissel in de beamerweergave elke 20 seconden tussen totaal en poules.
      beamerTimer = setInterval(() => {
        const views = standingsViews();
        if (views.length < 2) return;
        const i = views.findIndex(v => v.id === standingsView);
        standingsView = views[(i + 1) % views.length].id;
        renderStandings();
      }, 20000);
    }
  }

  init();
})();
