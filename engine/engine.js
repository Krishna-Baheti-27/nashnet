/*
 * NashNet simulation engine
 * -------------------------
 * Agent-based model of N autonomous tenants sharing a renewable,
 * multi-resource compute commons (GPU, bandwidth, power) on a grid.
 * Each tick: tenants serve one job, extract from capacity zones, meet
 * neighbours and play a donation game; platform mechanisms (memory,
 * reputation ledger, quotas, congestion pricing, audits) modify payoffs.
 *
 * Everything is driven by one seeded PRNG, so (seed, config) -> identical run.
 * Works in Node (module.exports) and in the browser (window.makeEngine).
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    gridSize: 20,          // G: the world is a G x G grid
    zonesPerType: 8,       // Z: capacity zones per resource type
    jobCost: 0.3,          // kappa: units of EACH resource consumed per job
    jobCredits: 2,         // credits earned per served job
    idlePower: 0.05,       // power drawn every tick by an online tenant
    movePower: 0.05,       // power cost of moving one cell
    slaGain: 3,            // SLA increase on a served job (capped at 100)
    slaLoss: 7,            // SLA decrease on a missed job
    radius: 3,             // interaction radius (Chebyshev distance)
    meetProb: 0.45,        // probability that an eligible pair actually meets
    noise: 0.03,           // execution error (trembling hand)
    giftCost: 1,           // c: units the giver loses when sharing
    giftBenefit: 3,        // b: units the receiver gains
    fairTake: 3,           // max units per extraction for fair tenants / under quota
    greedyTake: 6,         // max units per extraction for greedy tenants
    reserve: 0.4,          // u_res: safe reserve as a fraction of zone capacity
    desperate: 1,          // hardship threshold: stock below this exempts the reserve rule
    stockCap: 9,           // tenants stop collecting a type above this stock
    auditProb: 0.4,        // p: probability an offence is detected
    auditFine: 4,          // F: credit fine on detection
    auditRestitution: 2,   // rho: units returned to the victim (or zone)
    grabProb: 0.6,         // success probability of a forced grab
    grabAmount: 2,         // units taken by a successful grab
    grabPenalty: 1,        // power wasted by a failed grab
    priceLow: 0.3,         // tau_low: credits per unit when the zone stays above reserve
    priceHigh: 1.5,        // tau_high: credits per unit when the zone ends below reserve
    regenBase: 0.12,       // alpha in g(u) = r (alpha + beta u (1-u))
    regenShape: 3.5,       // beta
    standing: 0.45,        // defecting against a partner with reputation below this is justified
    ledgerRefuse: 0.3,     // ledger-aware strategies refuse partners below this reputation
    traderTrust: 0.45,     // Trader cooperates if private trust >= this
    checkerTrust: 0.5      // Checker cooperates if reputation (or trust) >= this
  };

  var STRATS = {
    TFT: { name: 'Tit-for-Tat', short: 'Mirror', glyph: 'T', color: '#6E8BFF', team: 'coop', extraction: 'fair', ledgerAware: true,
      blurb: 'Nice first, then copies what you did to it last time.' },
    ALLD: { name: 'Always Defect', short: 'Hoarder', glyph: 'D', color: '#FF6B4A', team: 'selfish', extraction: 'greedy', ledgerAware: false,
      blurb: 'Takes what is offered, never gives anything back, and over-drains zones.' },
    ALLC: { name: 'Always Cooperate', short: 'Giver', glyph: 'C', color: '#2DD4A7', team: 'coop', extraction: 'fair', ledgerAware: false,
      blurb: 'Always shares spare capacity, even with cheaters.' },
    TRADER: { name: 'Trader', short: 'Trader', glyph: '$', color: '#C08BFF', team: 'coop', extraction: 'fair', ledgerAware: true,
      blurb: 'Swaps only with partners it trusts at least a little.' },
    AGGR: { name: 'Aggressive', short: 'Grabber', glyph: 'A', color: '#FF4D8D', team: 'selfish', extraction: 'greedy', ledgerAware: false,
      blurb: 'Tries to take other tenants’ capacity by force, and over-drains zones.' },
    REP: { name: 'Reputation-aware', short: 'Checker', glyph: 'R', color: '#E8ECF4', team: 'coop', extraction: 'fair', ledgerAware: true,
      blurb: 'Checks a partner’s reputation before cooperating.' }
  };
  var STRAT_KEYS = ['TFT', 'ALLC', 'TRADER', 'REP', 'ALLD', 'AGGR'];
  var PLAN = ['TFT', 'TFT', 'ALLD', 'ALLD', 'ALLC', 'ALLC', 'TRADER', 'TRADER', 'AGGR', 'REP'];
  var KINDS = ['compute', 'bw', 'power'];
  var LABEL = { compute: 'GPU', bw: 'bandwidth', power: 'power' };
  var SCARCITY = {
    abundant: { max: 14, regen: 0.7, label: 'Abundant' },
    normal: { max: 10, regen: 0.45, label: 'Normal' },
    shortage: { max: 8, regen: 0.3, label: 'Shortage' }
  };
  var RULESETS = {
    none: { label: 'No rules', regs: { memory: false } },
    memory: { label: 'Memory only', regs: { memory: true } },
    rep: { label: 'Memory + reputation', regs: { memory: true, ledger: true } },
    quota: { label: 'Commons quotas', regs: { memory: false, quotas: true } },
    pricing: { label: 'Congestion pricing', regs: { memory: false, pricing: true } },
    audit: { label: 'Random audits', regs: { memory: false, audits: true } },
    repaudit: { label: 'Reputation + audits', regs: { memory: true, ledger: true, audits: true } },
    all: { label: 'Everything on', regs: { memory: true, ledger: true, audits: true, quotas: true, pricing: true } }
  };

  // mulberry32: small, fast, well-distributed 32-bit PRNG
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, r) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function richest(a) { return KINDS.reduce(function (x, k) { return a[k] > a[x] ? k : x; }, 'compute'); }
  function poorest(a) { return KINDS.reduce(function (x, k) { return a[k] < a[x] ? k : x; }, 'compute'); }
  function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

  function create(o) {
    o = o || {};
    var P = Object.assign({}, DEFAULTS, o.params || {});
    var seed = o.seed || 42, scarcity = o.scarcity || 'shortage';
    var regs = Object.assign({ memory: true, ledger: false, audits: false, pricing: false, quotas: false }, o.regs || {});
    var plan = o.plan || PLAN;
    var r = rng(seed);
    var sc = SCARCITY[scarcity];
    var G = P.gridSize, used = {};
    function free() {
      var x, y;
      do { x = Math.floor(r() * G); y = Math.floor(r() * G); } while (used[x + ',' + y]);
      used[x + ',' + y] = 1;
      return [x, y];
    }
    var zones = [];
    KINDS.forEach(function (type) {
      for (var i = 0; i < P.zonesPerType; i++) {
        var p = free();
        zones.push({ x: p[0], y: p[1], type: type, amt: sc.max * (0.5 + r() * 0.5), max: sc.max });
      }
    });
    var agents = plan.map(function (s, i) {
      var p = free();
      return { id: 'A' + (i + 1), strat: s, x: p[0], y: p[1], compute: 4 + r() * 5, bw: 4 + r() * 5, power: 5 + r() * 5,
        credits: 10, sla: 100, online: true, mem: {}, last: 'Just arrived', diedAt: null, fines: 0 };
    });
    return {
      P: P, r: r, sc: sc, scarcity: scarcity, regs: regs, zones: zones, agents: agents, tick: 0,
      events: [], links: [], ledger: {}, win: [], served: 0, demand: 0, flash: [], acts: 0, coops: 0,
      encounters: 0, pairs: {}, audits: 0, gifts: 0,
      hist: { online: [], coop: [], served: [], coopTeam: [], selfTeam: [], reserve: [] }
    };
  }

  // Laplace (Beta(1,1)) posterior mean of cooperation probability
  function trustOf(a, id) { var m = a.mem[id]; return m ? (m.c + 1) / (m.c + m.d + 2) : 0.5; }
  function rep(S, id) { var l = S.ledger[id]; return l ? (l.c + 1) / (l.c + l.d + 2) : 0.5; }

  function decide(S, a, b) {
    var P = S.P, reg = S.regs, m = reg.memory ? a.mem[b.id] : null;
    var act = 'C';
    if (a.strat === 'ALLD') act = 'D';
    else if (a.strat === 'TFT') act = m && m.lastThem === 'D' ? 'D' : 'C';
    else if (a.strat === 'TRADER') act = (reg.memory ? trustOf(a, b.id) : 0.5) >= P.traderTrust ? 'C' : 'D';
    else if (a.strat === 'AGGR') act = 'P';
    else if (a.strat === 'REP') act = (reg.ledger ? rep(S, b.id) : (reg.memory ? trustOf(a, b.id) : 0.5)) >= P.checkerTrust ? 'C' : 'D';
    if (reg.ledger && STRATS[a.strat].ledgerAware && rep(S, b.id) < P.ledgerRefuse) act = 'D';
    if (S.r() < P.noise) act = act === 'C' ? 'D' : 'C';
    return act;
  }
  function log(S, e) {
    S.events.unshift(Object.assign({ tick: S.tick }, e));
    if (S.events.length > 40) S.events.pop();
  }
  function fmt(v) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(v % 1 ? 1 : 0); }

  function interact(S, a, b) {
    var P = S.P, r = S.r, reg = S.regs;
    var xa = decide(S, a, b), xb = decide(S, b, a);
    // standing is judged on reputations BEFORE this encounter
    var repA = rep(S, a.id), repB = rep(S, b.id);
    var pay = {}; pay[a.id] = 0; pay[b.id] = 0;
    function give(f, t) {
      var k = richest(f);
      if (f[k] >= P.giftCost) { f[k] -= P.giftCost; t[poorest(t)] += P.giftBenefit; pay[f.id] -= P.giftCost; pay[t.id] += P.giftBenefit; S.gifts++; }
    }
    if (xa === 'C') give(a, b);
    if (xb === 'C') give(b, a);
    var kind, text, story, first = a, second = b;
    if (xa === 'P' || xb === 'P') {
      var ag = xa === 'P' ? a : b, vi = ag === a ? b : a;
      first = ag; second = vi; kind = 'GRAB';
      if (r() < P.grabProb) {
        var k = richest(vi), amt = Math.min(P.grabAmount, vi[k]);
        vi[k] -= amt; ag[k] += amt; pay[ag.id] += amt; pay[vi.id] -= amt;
        text = 'grabbed ' + LABEL[k] + ' by force';
        story = ag.id + ' forcibly took ' + amt.toFixed(1) + ' ' + LABEL[k] + ' from ' + vi.id + '.';
        ag.last = 'Grabbed ' + LABEL[k] + ' from ' + vi.id;
      } else {
        ag.power = Math.max(0, ag.power - P.grabPenalty); pay[ag.id] -= P.grabPenalty;
        text = 'grab failed, wasted power';
        story = ag.id + ' tried to grab from ' + vi.id + ' but failed and wasted power.';
        ag.last = 'Failed grab on ' + vi.id;
      }
      vi.last = 'Targeted by ' + ag.id;
    } else if (xa === 'C' && xb === 'C') {
      var tr = a.strat === 'TRADER' || b.strat === 'TRADER';
      kind = tr ? 'SWAP' : 'SHARE';
      text = tr ? 'swapped spare capacity' : 'shared spare capacity';
      story = a.id + ' and ' + b.id + ' ' + (tr ? 'swapped' : 'shared') + ' spare capacity. Both end up better off (+2 each).';
      a.last = (tr ? 'Swapped with ' : 'Shared with ') + b.id;
      b.last = (tr ? 'Swapped with ' : 'Shared with ') + a.id;
    } else if (xa === 'D' && xb === 'D') {
      kind = 'REFUSE'; text = 'both refused to share';
      story = a.id + ' and ' + b.id + ' both refused to share. Nobody gains.';
      a.last = 'Refused ' + b.id; b.last = 'Refused ' + a.id;
    } else {
      var d = xa === 'D' ? a : b, v = d === a ? b : a;
      first = d; second = v; kind = 'CHEAT';
      text = 'took capacity, gave nothing back';
      story = d.id + ' accepted ' + v.id + '’s capacity and gave nothing back.' + (reg.memory ? ' ' + v.id + ' will remember this.' : ' With memory off, ' + v.id + ' will forget.');
      d.last = 'Cheated ' + v.id; v.last = 'Cheated by ' + d.id;
    }
    if (reg.memory) {
      var rec = function (self, other, act) {
        var m = self.mem[other.id] || (self.mem[other.id] = { c: 0, d: 0, n: 0, lastThem: null });
        if (act === 'C') m.c++; else m.d++;
        m.n++; m.lastThem = act === 'C' ? 'C' : 'D';
      };
      rec(a, b, xb); rec(b, a, xa);
    }
    // public ledger with a standing rule: refusing a partner of bad standing is not held against you
    [[a, xa, repB], [b, xb, repA]].forEach(function (p) {
      var l = S.ledger[p[0].id] || (S.ledger[p[0].id] = { c: 0, d: 0 });
      if (p[1] === 'C') l.c++;
      else if (!(p[1] === 'D' && p[2] < P.standing)) l.d++;
    });
    log(S, { a: first.id, b: second.id, text: text, story: story, kind: kind, pay: fmt(pay[first.id]) + ' / ' + fmt(pay[second.id]) });
    S.flash = S.flash.concat([a.id, b.id]);
    S.links.push({ a: a.id, b: b.id, kind: kind === 'SHARE' || kind === 'SWAP' ? 'coop' : 'defect', ttl: 5 });
    // audits: ANY non-cooperative move (defect or grab) by ANY tenant is an offence, detected with prob p
    if (reg.audits) {
      [[a, xa, b], [b, xb, a]].forEach(function (p) {
        if (p[1] !== 'C' && r() < P.auditProb) {
          var k = richest(p[0]), back = Math.min(P.auditRestitution, p[0][k]);
          p[0][k] -= back; p[2][k] += back; p[0].credits -= P.auditFine; p[0].fines += P.auditFine; S.audits++;
          log(S, { a: p[0].id, b: p[2].id, text: 'audited: fined, partner repaid', story: 'Audit! ' + p[0].id + ' was caught not cooperating with ' + p[2].id + ': fined ' + P.auditFine + ' credits and ' + back.toFixed(1) + ' ' + LABEL[k] + ' was paid to ' + p[2].id + '.', kind: 'AUDIT', pay: '−' + P.auditFine });
        }
      });
    }
    var key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
    S.pairs[key] = (S.pairs[key] || 0) + 1;
    S.encounters++;
    var cc = (xa === 'C' ? 1 : 0) + (xb === 'C' ? 1 : 0);
    S.acts += 2; S.coops += cc;
    return cc;
  }

  function step(S) {
    var P = S.P, r = S.r, reg = S.regs, G = P.gridSize;
    S.tick++; S.flash = [];
    var tc = 0, ta = 0;
    var live = shuffle(S.agents.filter(function (a) { return a.online; }), r);
    live.forEach(function (a) {
      // 1. serve one job (Leontief: needs kappa of every resource)
      a.power = Math.max(0, a.power - P.idlePower);
      S.demand++;
      if (a.compute >= P.jobCost && a.bw >= P.jobCost && a.power >= P.jobCost) {
        a.compute -= P.jobCost; a.bw -= P.jobCost; a.power -= P.jobCost;
        a.credits += P.jobCredits; a.sla = Math.min(100, a.sla + P.slaGain); S.served++;
      } else a.sla -= P.slaLoss;
      if (a.sla <= 0) {
        a.online = false; a.sla = 0; a.power = Math.max(0, a.power); a.last = 'Went offline'; a.diedAt = S.tick;
        log(S, { a: a.id, b: '', text: 'went offline', story: a.id + ' (' + STRATS[a.strat].name + ') ran out of resources and went offline.', kind: 'OFFLINE', pay: '' });
        return;
      }
      // 2. extraction policy: fair tenants keep the reserve; greedy tenants ignore it unless quotas/pricing apply
      var greedy = STRATS[a.strat].extraction === 'greedy';
      var restrained = !greedy || reg.quotas || reg.pricing;
      var avail = function (z, desperate) { return z.amt - (restrained && !desperate ? P.reserve * z.max : 0); };
      var need = poorest(a);
      var desperate = a[need] < P.desperate;
      var here = null;
      for (var zi = 0; zi < S.zones.length; zi++) {
        var zz = S.zones[zi];
        if (zz.x === a.x && zz.y === a.y && a[zz.type] < P.stockCap && avail(zz, a[zz.type] < P.desperate) >= 0.5) { here = zz; break; }
      }
      var best = here, bd = here ? 0 : 1e9;
      if (!here) {
        S.zones.forEach(function (z) {
          if (z.type === need && avail(z, desperate) >= 1) {
            var d = cheb(z, a);
            if (d < bd) { bd = d; best = z; }
          }
        });
      }
      if (best && bd > 0) {
        a.x += Math.sign(best.x - a.x); a.y += Math.sign(best.y - a.y); a.power = Math.max(0, a.power - P.movePower);
        a.last = 'Moving to a ' + LABEL[need] + ' zone';
      } else if (best) {
        var hard = a[best.type] < P.desperate;
        var cap = reg.quotas ? P.fairTake : (greedy ? P.greedyTake : P.fairTake);
        var take = Math.max(0, Math.min(cap, avail(best, hard)));
        var belowReserve = best.amt - take < P.reserve * best.max;
        best.amt -= take; a[best.type] += take;
        if (reg.pricing) a.credits -= take * (belowReserve ? P.priceHigh : P.priceLow);
        a.last = (greedy && !restrained ? 'Hoarded ' : 'Collected ') + take.toFixed(1) + ' ' + LABEL[best.type];
        // commons rule: do not leave a zone below its reserve unless in hardship; audited for EVERY tenant
        if (reg.audits && belowReserve && !hard && take > 0 && r() < P.auditProb) {
          var back = Math.min(take, a[best.type]);
          a[best.type] -= back; best.amt += back; a.credits -= P.auditFine; a.fines += P.auditFine; S.audits++;
          log(S, { a: a.id, b: '', text: 'audited: over-draining a zone', story: 'Audit! ' + a.id + ' was caught draining a ' + LABEL[best.type] + ' zone below its safe reserve: fined ' + P.auditFine + ' credits and ' + back.toFixed(1) + ' units returned to the zone.', kind: 'AUDIT', pay: '−' + P.auditFine });
        }
      } else {
        a.x = Math.max(0, Math.min(G - 1, a.x + Math.round(r() * 2 - 1)));
        a.y = Math.max(0, Math.min(G - 1, a.y + Math.round(r() * 2 - 1)));
        a.last = 'Searching for ' + LABEL[need];
      }
    });
    // 3. encounters: random greedy matching on the proximity graph (order shuffled every tick)
    var busy = {};
    var on = shuffle(S.agents.filter(function (a) { return a.online; }), r);
    for (var i = 0; i < on.length; i++) {
      for (var j = i + 1; j < on.length; j++) {
        var a = on[i], b = on[j];
        if (busy[a.id] || busy[b.id]) continue;
        if (cheb(a, b) <= P.radius && r() < P.meetProb) {
          busy[a.id] = 1; busy[b.id] = 1;
          tc += interact(S, a, b); ta += 2;
        }
      }
    }
    // 4. renewable regrowth g(u) = r (alpha + beta u (1 - u))
    S.zones.forEach(function (z) {
      var u = Math.max(0, z.amt) / z.max;
      z.amt = Math.min(z.max, z.amt + S.sc.regen * (P.regenBase + P.regenShape * u * (1 - u)));
    });
    S.links = S.links.map(function (l) { return Object.assign({}, l, { ttl: l.ttl - 1 }); }).filter(function (l) { return l.ttl > 0; });
    S.win.push([tc, ta]); if (S.win.length > 10) S.win.shift();
    var wc = S.win.reduce(function (p, w) { return p + w[0]; }, 0), wa = S.win.reduce(function (p, w) { return p + w[1]; }, 0);
    var H = S.hist;
    H.online.push(S.agents.filter(function (a) { return a.online; }).length);
    H.coop.push(wa ? wc / wa : (H.coop.length ? H.coop[H.coop.length - 1] : 0.5));
    H.served.push(S.demand ? S.served / S.demand : 1);
    H.coopTeam.push(teamCredits(S, 'coop')); H.selfTeam.push(teamCredits(S, 'selfish'));
    H.reserve.push(meanReserve(S));
  }
  function teamCredits(S, t) {
    var g = S.agents.filter(function (a) { return STRATS[a.strat].team === t; });
    return g.length ? g.reduce(function (p, a) { return p + a.credits; }, 0) / g.length : 0;
  }
  function meanReserve(S) { return S.zones.reduce(function (p, z) { return p + Math.max(0, z.amt) / z.max; }, 0) / S.zones.length; }
  function gini(xs) {
    var v = xs.map(function (x) { return Math.max(0, x); }).sort(function (p, q) { return p - q; });
    var n = v.length, s = v.reduce(function (p, q) { return p + q; }, 0);
    if (!s) return 0;
    var g = 0; v.forEach(function (x, i) { g += (2 * (i + 1) - n - 1) * x; });
    return g / (n * s);
  }
  function summary(S) {
    var n = S.agents.length;
    var online = S.agents.filter(function (a) { return a.online; }).length;
    var ct = teamCredits(S, 'coop'), st = teamCredits(S, 'selfish');
    var pairsMet = Object.keys(S.pairs).length;
    return {
      online: online,
      survival: online / n,
      served: S.demand ? S.served / S.demand : 1,
      cheatAdv: ct > 0 ? st / ct - 1 : 0,
      coop: S.acts ? S.coops / S.acts : 0,
      gini: gini(S.agents.map(function (a) { return a.credits; })),
      reserve: meanReserve(S),
      encounters: S.encounters,
      pairsMet: pairsMet,
      wHat: S.encounters ? 1 - pairsMet / S.encounters : 0,
      audits: S.audits,
      gifts: S.gifts
    };
  }
  function run(o, ticks) {
    var S = create(o);
    var T = ticks || 150;
    for (var t = 0; t < T; t++) step(S);
    var s = summary(S);
    s.byStrategy = {};
    STRAT_KEYS.forEach(function (k) {
      var g = S.agents.filter(function (a) { return a.strat === k; });
      if (g.length) s.byStrategy[k] = { n: g.length, credits: g.reduce(function (p, a) { return p + a.credits; }, 0) / g.length, online: g.filter(function (a) { return a.online; }).length };
    });
    s.selfishOffline = S.agents.filter(function (a) { return !a.online && STRATS[a.strat].team === 'selfish'; }).length;
    s.coopOffline = S.agents.filter(function (a) { return !a.online && STRATS[a.strat].team === 'coop'; }).length;
    return s;
  }

  function makeEngine() {
    return {
      DEFAULTS: DEFAULTS, STRATS: STRATS, STRAT_KEYS: STRAT_KEYS, PLAN: PLAN, KINDS: KINDS, LABEL: LABEL,
      SCARCITY: SCARCITY, RULESETS: RULESETS,
      rng: rng, create: create, step: step, summary: summary, run: run, gini: gini,
      trustOf: trustOf, rep: rep, richest: richest, poorest: poorest
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = makeEngine;
  else root.makeEngine = makeEngine;
})(typeof window !== 'undefined' ? window : this);
