// Schema-generator: elke ronde nieuwe teams, zo min mogelijk herhaling van
// medespelers/tegenstanders en zo gelijk mogelijke teamsterkte.
const Scheduler = (() => {
  const uid = () => Math.random().toString(36).slice(2, 10);
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const rand = n => Math.floor(Math.random() * n);
  const inc = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  const shuffle = arr => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  const SPREAD_WEIGHT = { mixed: 0, balanced: 3, similar: 14 };

  function makeContext(players, rounds, levelMode) {
    const ctx = {
      level: new Map(players.map(p => [p.id, Number(p.level) || 5])),
      partner: new Map(),
      opp: new Map(),
      played: new Map(),
      lastPlayed: new Map(),
      spread: SPREAD_WEIGHT[levelMode] ?? 3,
    };
    rounds.forEach((r, ri) => r.matches.forEach(m => addMatch(ctx, m, ri)));
    return ctx;
  }

  function addMatch(ctx, m, ri) {
    [...m.teamA, ...m.teamB].forEach(id => {
      inc(ctx.played, id);
      ctx.lastPlayed.set(id, ri);
    });
    inc(ctx.partner, key(m.teamA[0], m.teamA[1]));
    inc(ctx.partner, key(m.teamB[0], m.teamB[1]));
    m.teamA.forEach(a => m.teamB.forEach(b => inc(ctx.opp, key(a, b))));
  }

  function lvl(ctx, id) {
    return ctx.level.has(id) ? ctx.level.get(id) : 5;
  }

  function splitCost(t1, t2, ctx) {
    const g = (map, k) => map.get(k) || 0;
    let c = 1000 * (g(ctx.partner, key(t1[0], t1[1])) + g(ctx.partner, key(t2[0], t2[1])));
    for (const a of t1) for (const b of t2) {
      const o = g(ctx.opp, key(a, b));
      c += 40 * o * o;
    }
    const d = lvl(ctx, t1[0]) + lvl(ctx, t1[1]) - lvl(ctx, t2[0]) - lvl(ctx, t2[1]);
    c += 12 * d * d;
    return c;
  }

  function bestSplit(four, ctx) {
    const [a, b, c, d] = four;
    const options = [[[a, b], [c, d]], [[a, c], [b, d]], [[a, d], [b, c]]];
    let best = null;
    for (const [t1, t2] of options) {
      const cost = splitCost(t1, t2, ctx);
      if (!best || cost < best.cost) best = { cost, teamA: t1, teamB: t2 };
    }
    const lv = four.map(id => lvl(ctx, id));
    best.cost += ctx.spread * (Math.max(...lv) - Math.min(...lv)) ** 1.5;
    return best;
  }

  // Verdeel spelers in groepjes van 4 via random restarts + lokale zoektocht (swaps).
  function partition(ids, ctx) {
    const n = ids.length / 4;
    if (n < 1) return [];
    let bestGroups = null;
    let bestCost = Infinity;
    const restarts = n === 1 ? 1 : 6;
    const iters = n === 1 ? 0 : 80 * n;
    for (let r = 0; r < restarts; r++) {
      const arr = shuffle(ids.slice());
      const groups = [];
      for (let i = 0; i < n; i++) groups.push(arr.slice(i * 4, i * 4 + 4));
      const costs = groups.map(g => bestSplit(g, ctx).cost);
      for (let it = 0; it < iters; it++) {
        const i = rand(n);
        let j = rand(n - 1);
        if (j >= i) j++;
        const gi = groups[i].slice();
        const gj = groups[j].slice();
        const pi = rand(4), pj = rand(4);
        [gi[pi], gj[pj]] = [gj[pj], gi[pi]];
        const ci = bestSplit(gi, ctx).cost;
        const cj = bestSplit(gj, ctx).cost;
        if (ci + cj <= costs[i] + costs[j]) {
          groups[i] = gi; groups[j] = gj; costs[i] = ci; costs[j] = cj;
        }
      }
      const total = costs.reduce((s, x) => s + x, 0);
      if (total < bestCost) {
        bestCost = total;
        bestGroups = groups.map(g => g.slice());
      }
    }
    return bestGroups.map(g => bestSplit(g, ctx));
  }

  // Spelers met de minste wedstrijden spelen eerst; wie het langst niet speelde gaat voor.
  function pickPlayers(ids, count, ctx) {
    const arr = shuffle(ids.slice());
    arr.sort((a, b) =>
      (ctx.played.get(a) || 0) - (ctx.played.get(b) || 0) ||
      (ctx.lastPlayed.get(a) ?? -1) - (ctx.lastPlayed.get(b) ?? -1));
    return arr.slice(0, count);
  }

  // Slangverdeling op niveau zodat poules even sterk zijn.
  function makePools(players, count) {
    const sorted = shuffle(players.slice()).sort((a, b) => b.level - a.level);
    const pools = Array.from({ length: count }, (_, i) => ({
      id: 'P' + i,
      name: 'Poule ' + String.fromCharCode(65 + i),
      playerIds: [],
    }));
    sorted.forEach((p, i) => {
      const row = Math.floor(i / count), col = i % count;
      pools[row % 2 === 0 ? col : count - 1 - col].playerIds.push(p.id);
    });
    return pools;
  }

  // Totale kwaliteit van een schema (lager is beter): herhaalde medespelers, vaak dezelfde
  // tegenstanders en ongelijke teams tellen zwaar mee.
  function scoreSchedule(players, rounds, fromRound, levelMode) {
    const ctx = makeContext(players, rounds, levelMode);
    let cost = 0;
    ctx.partner.forEach(c => { if (c > 1) cost += 700 * (c - 1); });
    ctx.opp.forEach(c => { cost += 10 * c * c; });
    rounds.slice(fromRound).forEach(r => r.matches.forEach(m => {
      const d = Math.abs(lvl(ctx, m.teamA[0]) + lvl(ctx, m.teamA[1]) - lvl(ctx, m.teamB[0]) - lvl(ctx, m.teamB[1]));
      cost += 15 * d * d + (d > 3 ? 4 * (d - 3) ** 3 : 0);
      const lv = [...m.teamA, ...m.teamB].map(id => lvl(ctx, id));
      cost += ctx.spread * (Math.max(...lv) - Math.min(...lv)) ** 1.5;
    }));
    return cost;
  }

  // Meerdere complete schema's proberen binnen een tijdsbudget en de beste houden.
  function generateRounds(opts, budgetMs = 1500) {
    const t0 = Date.now();
    let best = null, bestCost = Infinity, tries = 0;
    do {
      const rounds = generateOnce(opts);
      const cost = scoreSchedule(opts.players, rounds, opts.keptRounds.length, opts.levelMode);
      if (cost < bestCost) { bestCost = cost; best = rounds; }
      tries++;
    } while (Date.now() - t0 < budgetMs * 0.4 && tries < 400);
    improve(opts, best, bestCost, budgetMs * 0.6);
    return best;
  }

  // Lokale zoektocht over het hele schema: wissel twee spelers binnen dezelfde ronde (en poule)
  // en houd de wissel als het schema er niet slechter van wordt.
  function improve({ players, keptRounds, levelMode }, rounds, cost, budgetMs) {
    const from = keptRounds.length;
    if (rounds.length <= from) return;
    const t0 = Date.now();
    const slotsByRound = [];
    for (let ri = from; ri < rounds.length; ri++) {
      const slots = [];
      rounds[ri].matches.forEach(m => {
        ['teamA', 'teamB'].forEach(t => [0, 1].forEach(i => slots.push({ m, t, i })));
      });
      slotsByRound.push({ ri, slots });
    }
    const snapshot = () => rounds.map(r => r.matches.map(m => [m.teamA.slice(), m.teamB.slice()]));
    let best = snapshot(), bestCost = cost;
    const maxIt = 300000;
    for (let it = 0; Date.now() - t0 < budgetMs && it < maxIt; it++) {
      const { slots } = slotsByRound[rand(slotsByRound.length)];
      const a = slots[rand(slots.length)];
      const b = slots[rand(slots.length)];
      if (a.m === b.m && a.t === b.t) continue;
      if (a.m.pool !== b.m.pool) continue;
      const swap = () => {
        const x = a.m[a.t][a.i];
        a.m[a.t][a.i] = b.m[b.t][b.i];
        b.m[b.t][b.i] = x;
      };
      swap();
      const c = scoreSchedule(players, rounds, from, levelMode);
      // Simulated annealing: soms een slechtere stap accepteren om uit een dal te komen.
      const temp = 400 * (1 - (Date.now() - t0) / budgetMs) + 1;
      if (c <= cost || Math.random() < Math.exp((cost - c) / temp)) {
        cost = c;
        if (c < bestCost) { bestCost = c; best = snapshot(); }
      } else {
        swap();
      }
    }
    rounds.forEach((r, ri) => r.matches.forEach((m, mi) => {
      m.teamA = best[ri][mi][0];
      m.teamB = best[ri][mi][1];
    }));
  }

  function generateOnce({ players, courts, pools, keptRounds, totalRounds, levelMode, allocation }) {
    const activeSet = new Set(players.filter(p => p.active !== false).map(p => p.id));
    const ctx = makeContext(players, keptRounds, levelMode);
    const rounds = keptRounds.slice();
    const groups = pools && pools.length
      ? pools.map(p => ({ pool: p.id, ids: p.playerIds.filter(id => activeSet.has(id)) }))
      : [{ pool: null, ids: [...activeSet] }];

    for (let ri = keptRounds.length; ri < totalRounds; ri++) {
      // Vaste verdeling ("iedereen evenveel") of: de poule met het minste gemiddelde aantal
      // potjes krijgt de volgende baan.
      const alloc = allocation ? allocation[ri - keptRounds.length].slice() : groups.map(() => 0);
      for (let c = 0; !allocation && c < courts.length; c++) {
        let best = -1, bestScore = Infinity;
        groups.forEach((g, gi) => {
          if (alloc[gi] >= Math.floor(g.ids.length / 4)) return;
          const tot = g.ids.reduce((s, id) => s + (ctx.played.get(id) || 0), 0);
          const score = (tot + 4 * alloc[gi]) / g.ids.length + Math.random() * 1e-3;
          if (score < bestScore) { bestScore = score; best = gi; }
        });
        if (best < 0) break;
        alloc[best]++;
      }

      const matches = [];
      const resting = [];
      groups.forEach((g, gi) => {
        const playing = pickPlayers(g.ids, alloc[gi] * 4, ctx);
        const ps = new Set(playing);
        g.ids.forEach(id => { if (!ps.has(id)) resting.push(id); });
        partition(playing, ctx).forEach(m => matches.push({ pool: g.pool, teamA: m.teamA, teamB: m.teamB }));
      });
      matches.forEach((m, i) => {
        m.id = uid();
        m.courtId = courts[i].id;
        m.scoreA = null;
        m.scoreB = null;
        addMatch(ctx, m, ri);
      });
      rounds.push({ id: uid(), matches, resting });
    }
    return rounds;
  }

  // ---------- verdeling van potjes ----------

  // "Banen maximaal bezet": dezelfde baanverdeling als het schema, om vooraf te tonen
  // hoeveel potjes ieder speelt. sizes = aantal aanwezige spelers per poule.
  function maxAllocation(sizes, courtsN, rounds) {
    const caps = sizes.map(n => Math.floor(n / 4));
    const games = sizes.map(() => 0);
    const perRound = [];
    for (let r = 0; r < rounds; r++) {
      const alloc = sizes.map(() => 0);
      for (let c = 0; c < courtsN; c++) {
        let best = -1, bestScore = Infinity;
        sizes.forEach((n, i) => {
          if (alloc[i] >= caps[i]) return;
          const score = (games[i] + 4 * alloc[i]) / n;
          if (score < bestScore) { bestScore = score; best = i; }
        });
        if (best < 0) break;
        alloc[best]++;
      }
      alloc.forEach((a, i) => { games[i] += 4 * a; });
      perRound.push(alloc);
    }
    return { perRound, matches: games.map(g => g / 4) };
  }

  // "Iedereen evenveel potjes": hoogste aantal G waarbij iedere aanwezige speler precies G
  // potjes speelt. counts = per poule de al gespeelde potjes per speler (bij herplannen).
  function equalAllocation(counts, courtsN, rounds) {
    if (!rounds) return null;
    const caps = counts.map(c => Math.floor(c.length / 4));
    const maxPlayed = Math.max(0, ...counts.flat());
    for (let G = maxPlayed + rounds; G >= Math.max(1, maxPlayed); G--) {
      const need = counts.map(c => c.reduce((s, x) => s + (G - x), 0));
      if (need.some(n => n % 4)) continue;
      if (counts.some(c => c.some(x => G - x > rounds))) continue;
      const M = need.map(n => n / 4);
      if (M.some((m, i) => m > caps[i] * rounds)) continue;
      if (M.reduce((a, b) => a + b, 0) > courtsN * rounds) continue;
      const perRound = spread(M, caps, courtsN, rounds);
      if (perRound) return { games: G, perRound, matches: M, idle: courtsN * rounds - M.reduce((a, b) => a + b, 0) };
    }
    return null;
  }

  // Verdeel per poule M potjes zo gelijkmatig mogelijk over de rondes, binnen het aantal banen.
  function spread(M, caps, courtsN, rounds) {
    const rem = M.slice();
    const perRound = [];
    for (let r = 0; r < rounds; r++) {
      const left = rounds - r;
      const a = rem.map((m, i) => Math.min(caps[i], Math.ceil(m / left)));
      const must = rem.map((m, i) => Math.max(0, m - caps[i] * (left - 1)));
      let sum = a.reduce((x, y) => x + y, 0);
      while (sum > courtsN) {
        let best = -1;
        a.forEach((v, i) => { if (v > must[i] && (best < 0 || v - must[i] > a[best] - must[best])) best = i; });
        if (best < 0) return null;
        a[best]--; sum--;
      }
      let rest = rem.reduce((s, m, i) => s + m - a[i], 0);
      while (rest > courtsN * (left - 1) && sum < courtsN) {
        let best = -1;
        a.forEach((v, i) => { if (v < caps[i] && v < rem[i] && (best < 0 || rem[i] - v > rem[best] - a[best])) best = i; });
        if (best < 0) return null;
        a[best]++; sum++; rest--;
      }
      if (rest > courtsN * (left - 1)) return null;
      a.forEach((v, i) => { rem[i] -= v; });
      perRound.push(a);
    }
    return rem.every(x => x === 0) ? perRound : null;
  }

  // Volgorde in een knock-outschema zodat 1 en 2 pas in de finale kunnen treffen.
  function bracketOrder(n) {
    let order = [0, 1];
    while (order.length < n) {
      const m = order.length * 2;
      order = order.flatMap(s => [s, m - 1 - s]);
    }
    return order;
  }

  return { uid, shuffle, makePools, generateRounds, bracketOrder, maxAllocation, equalAllocation };
})();
