// Runs every experiment reported in the paper and writes the results to data/*.csv.
// Usage: node scripts/run-experiments.js [--seeds 100]
//
//   E1  main grid       8 rule sets x 3 supply levels x n seeds          -> data/e1_main.csv
//   E2  audit sweep     audit probability p in [0, 1], shortage           -> data/e2_audit_sweep.csv
//   E3  time series     per-tick means for four rule sets, shortage       -> data/e3_timeseries.csv
//   E4  evolution       discrete replicator dynamics over generations     -> data/e4_replicator.csv
//   E5  robustness      noise and interaction radius sensitivity          -> data/e5_robustness.csv
const fs = require('fs');
const path = require('path');
const makeEngine = require('../engine/engine.js');
const E = makeEngine();

const args = process.argv.slice(2);
const SEEDS = args.indexOf('--seeds') >= 0 ? parseInt(args[args.indexOf('--seeds') + 1], 10) : 100;
const TICKS = 150;
const OUT = path.resolve(__dirname, '..', 'data');
fs.mkdirSync(OUT, { recursive: true });

function writeCsv(file, rows) {
  const cols = Object.keys(rows[0]);
  const esc = v => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(6)) : String(v));
  const body = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, file), body);
  console.log('wrote data/' + file + ' (' + rows.length + ' rows)');
}
function flat(exp, extra, m) {
  const row = Object.assign({ experiment: exp }, extra, {
    online: m.online, survival: m.survival, served: m.served, cheat_adv: m.cheatAdv, coop_rate: m.coop,
    gini: m.gini, reserve: m.reserve, encounters: m.encounters, pairs_met: m.pairsMet, w_hat: m.wHat,
    audits: m.audits, gifts: m.gifts, coop_offline: m.coopOffline, selfish_offline: m.selfishOffline
  });
  E.STRAT_KEYS.forEach(k => { row['credits_' + k] = m.byStrategy[k] ? m.byStrategy[k].credits : ''; });
  return row;
}
const RULES = Object.keys(E.RULESETS);
const SUPPLY = ['abundant', 'normal', 'shortage'];
const t0 = Date.now();

// E1: main grid -----------------------------------------------------------------
const e1 = [];
for (const supply of SUPPLY)
  for (const rule of RULES)
    for (let seed = 1; seed <= SEEDS; seed++)
      e1.push(flat('E1', { ruleset: rule, supply, seed }, E.run({ seed, scarcity: supply, regs: E.RULESETS[rule].regs }, TICKS)));
writeCsv('e1_main.csv', e1);

// E2: audit-probability sweep (audits only, shortage) ----------------------------
const P_GRID = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const e2 = [];
for (const p of P_GRID)
  for (let seed = 1; seed <= SEEDS; seed++)
    e2.push(flat('E2', { ruleset: 'audit', supply: 'shortage', audit_prob: p, seed },
      E.run({ seed, scarcity: 'shortage', regs: { memory: false, audits: true }, params: { auditProb: p } }, TICKS)));
writeCsv('e2_audit_sweep.csv', e2);

// E3: per-tick time series (means over seeds) ------------------------------------
const e3 = [];
for (const rule of ['none', 'rep', 'quota', 'audit']) {
  const acc = { online: new Array(TICKS).fill(0), reserve: new Array(TICKS).fill(0), coopTeam: new Array(TICKS).fill(0), selfTeam: new Array(TICKS).fill(0), coop: new Array(TICKS).fill(0) };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const S = E.create({ seed, scarcity: 'shortage', regs: E.RULESETS[rule].regs });
    for (let t = 0; t < TICKS; t++) E.step(S);
    for (let t = 0; t < TICKS; t++) {
      acc.online[t] += S.hist.online[t]; acc.reserve[t] += S.hist.reserve[t];
      acc.coopTeam[t] += S.hist.coopTeam[t]; acc.selfTeam[t] += S.hist.selfTeam[t]; acc.coop[t] += S.hist.coop[t];
    }
  }
  for (let t = 0; t < TICKS; t++)
    e3.push({ experiment: 'E3', ruleset: rule, supply: 'shortage', tick: t + 1, online: acc.online[t] / SEEDS, reserve: acc.reserve[t] / SEEDS,
      credits_coop_team: acc.coopTeam[t] / SEEDS, credits_selfish_team: acc.selfTeam[t] / SEEDS, coop_rate_window: acc.coop[t] / SEEDS });
}
writeCsv('e3_timeseries.csv', e3);

// E4: discrete replicator dynamics ------------------------------------------------
// x_s(g+1) = x_s(g) f_s(g) / sum_k x_k(g) f_k(g); f_s = mean final credits of strategy s,
// estimated from M seasons played by a 10-tenant population apportioned from x(g).
function apportion(x, n) {
  const raw = x.map(v => v * n), base = raw.map(Math.floor);
  let left = n - base.reduce((p, q) => p + q, 0);
  const order = raw.map((v, i) => [v - base[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < order.length && left > 0; k++) { if (x[order[k][1]] > 0) { base[order[k][1]]++; left--; } }
  return base;
}
const GENS = 40, M = 20, POP = 10;
const e4 = [];
for (const rule of ['none', 'rep', 'quota', 'audit']) {
  let x = E.STRAT_KEYS.map(() => 1 / E.STRAT_KEYS.length);
  for (let g = 0; g <= GENS; g++) {
    const counts = apportion(x, POP);
    const plan = [];
    E.STRAT_KEYS.forEach((k, i) => { for (let c = 0; c < counts[i]; c++) plan.push(k); });
    const sum = E.STRAT_KEYS.map(() => 0), num = E.STRAT_KEYS.map(() => 0);
    for (let m = 1; m <= M; m++) {
      const res = E.run({ seed: 100000 + g * 1000 + m, scarcity: 'shortage', regs: E.RULESETS[rule].regs, plan }, TICKS);
      E.STRAT_KEYS.forEach((k, i) => { if (res.byStrategy[k]) { sum[i] += res.byStrategy[k].credits; num[i]++; } });
    }
    const f = E.STRAT_KEYS.map((k, i) => (num[i] ? Math.max(1e-6, sum[i] / num[i]) : 0));
    E.STRAT_KEYS.forEach((k, i) => e4.push({ experiment: 'E4', ruleset: rule, supply: 'shortage', generation: g, strategy: k, share: x[i], count: counts[i], fitness: f[i] }));
    // strategies with no tenants this generation cannot reproduce
    const xf = x.map((v, i) => (counts[i] > 0 ? v * f[i] : 0));
    const tot = xf.reduce((p, q) => p + q, 0);
    x = xf.map(v => v / tot);
  }
}
writeCsv('e4_replicator.csv', e4);

// E5: robustness to execution noise and interaction radius -----------------------
const e5 = [];
for (const rule of ['none', 'memory', 'rep', 'quota', 'audit'])
  for (const [param, values] of [['noise', [0, 0.03, 0.1]], ['radius', [2, 3, 4]]])
    for (const v of values)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const params = {}; params[param] = v;
        e5.push(flat('E5', { ruleset: rule, supply: 'shortage', param, value: v, seed },
          E.run({ seed, scarcity: 'shortage', regs: E.RULESETS[rule].regs, params }, TICKS)));
      }
writeCsv('e5_robustness.csv', e5);

console.log('done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
