// Runs app.js without a browser using a minimal DOM stub, then checks behaviour.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true });
const el = () => ({ style: {}, classList: { toggle() {}, remove() {} }, getBoundingClientRect: () => ({ width: 600, height: 190 }),
  getContext: () => ctxStub, setAttribute() {}, value: '1200', textContent: '', innerHTML: '' });
const sandbox = { document: { getElementById: () => el(), querySelectorAll: () => [], documentElement: {} },
  getComputedStyle: () => ({ getPropertyValue: () => '#fff' }), devicePixelRatio: 1, performance: { now: () => 0 },
  setInterval: () => {}, console, Math };
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
vm.runInContext(src + '\n;globalThis.__api={get S(){return S},reset(){S=S0()},tick(n){for(let i=0;i<n*10;i++)step(0.1);render()}};', sandbox);
const api = sandbox.__api; let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fails++; };

api.reset(); api.tick(5);
check('nominal: ATS on utility, load energized', api.S.ats === 'UTIL' && api.S.ok);

api.S.grid = false; api.tick(30);
check('outage: genset running and ATS on GEN', api.S.gs === 'RUN' && api.S.ats === 'GEN');
check('outage: load never dropped', api.S.ok);

api.S.grid = true; api.tick(40);
check('restore: retransfer to utility after stable timer', api.S.ats === 'UTIL');

api.reset(); api.S.gf = true; api.S.grid = false; api.tick(1200);
check('genset fault: battery exhausts and load is lost', api.S.gs === 'FAULT' && !api.S.ok);

api.reset(); api.S.surge = 100; api.S.it = 1500; api.tick(70);
check('overload: UPS transfers to static bypass', api.S.um === 'BYPASS');

process.exit(fails ? 1 : 0);
