// Sanity checks for the engine: determinism and basic invariants.
// Usage: node scripts/check.js
const makeEngine = require('../engine/engine.js');
const E = makeEngine();

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? ' (' + detail + ')' : '')); }
}

console.log('determinism');
for (const rule of Object.keys(E.RULESETS)) {
  const a = E.run({ seed: 7, scarcity: 'shortage', regs: E.RULESETS[rule].regs });
  const b = E.run({ seed: 7, scarcity: 'shortage', regs: E.RULESETS[rule].regs });
  check('same seed gives the same season: ' + rule, JSON.stringify(a) === JSON.stringify(b));
}

console.log('invariants (20 seeds x 8 rule sets x 3 supply levels)');
let negStock = 0, negHold = 0, overCap = 0, zombie = 0, badSla = 0, reserveBreach = 0;
for (const supply of ['abundant', 'normal', 'shortage'])
  for (const rule of Object.keys(E.RULESETS))
    for (let seed = 1; seed <= 20; seed++) {
      const S = E.create({ seed, scarcity: supply, regs: E.RULESETS[rule].regs });
      const offline = new Set();
      for (let t = 0; t < 150; t++) {
        const before = S.agents.map(a => [a.id, a.x, a.y, a.credits]);
        E.step(S);
        S.zones.forEach(z => { if (z.amt < -1e-9) negStock++; if (z.amt > z.max + 1e-9) overCap++; });
        S.agents.forEach(a => {
          E.KINDS.forEach(k => { if (a[k] < -1e-9) negHold++; });
          if (a.sla < 0 || a.sla > 100) badSla++;
        });
        before.forEach(([id, x, y, cr]) => {
          const a = S.agents.find(q => q.id === id);
          if (offline.has(id) && (a.x !== x || a.y !== y || a.credits !== cr)) zombie++;
        });
        S.agents.forEach(a => { if (!a.online) offline.add(a.id); });
        if (rule === 'quota') {
          // with quotas the reserve can only be breached by tenants in hardship; zones must never go below zero
          S.zones.forEach(z => { if (z.amt < 0) reserveBreach++; });
        }
      }
    }
check('zone stock never negative', negStock === 0, negStock);
check('zone stock never above capacity', overCap === 0, overCap);
check('tenant holdings never negative', negHold === 0, negHold);
check('SLA stays in [0, 100]', badSla === 0, badSla);
check('offline tenants never act again', zombie === 0, zombie);
check('quotas never drive a zone below zero', reserveBreach === 0, reserveBreach);

console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
process.exit(failures ? 1 : 0);
