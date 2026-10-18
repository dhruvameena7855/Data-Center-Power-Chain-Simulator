const $ = id => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const UPS_KW = 2000, BATT_KWH = 300, GEN_KW = 2500;
const S0 = () => ({
  t: 0, grid: true, gB: 0, gG: 99, ats: 'UTIL', gap: 0, gs: 'OFF', gT: 0, gf: false,
  fuel: 100, soc: 100, um: 'ONLINE', ov: 0, ovc: 0, it: +$('it').value, surge: 0,
  roomT: 22, eIT: 0, eT: 0, up: 0, tot: 0, ok: true, tr: 0, drill: 0, ovl: false,
  gOv: false, m: null
});
let S = S0(), H = { p: [], q: [], b: [] }, speed = 1, logs = [];

function log(m, c) {
  const ts = S.t.toFixed(0).padStart(4, '0');
  logs.unshift(`<div style="color:${c || 'inherit'}"><span style="color:var(--mu);margin-right:6px">[${ts}s]</span>${m}</div>`);
  logs.length = 60;
  if ($('log')) $('log').innerHTML = logs.join('');
}

const setpoint = base => {
  const s = $('strat').value;
  return s === 'FIXED' ? 18 : s === 'MANUAL' ? +$('sp').value : +(25 - 3 * clamp((base - 1200) / 600, 0, 1) - (amb() > 30 ? 1.5 : 0)).toFixed(1);
};
const amb = () => +$('amb').value;
const upsEff = f => f <= 0 ? 0.9 : 0.965 - 0.07 * Math.exp(-f * 10);

function model(sp, base, mode, live) {
  const pen = sp > 24 ? 1 + 0.012 * Math.pow(sp - 24, 1.3) : 1, it = base * pen, f = it / UPS_KW;
  const eff = mode === 'BYPASS' ? 0.99 : upsEff(f), upsIn = it / eff + (mode === 'ONLINE' && S.soc < 100 ? 100 : 0), upsLoss = upsIn - it;
  const heat = it + upsLoss, fc = clamp((sp - 6 - amb()) / 6, 0, 1);
  const cop = (3.2 + 0.22 * (sp - 18)) * (1 - 0.012 * Math.max(0, amb() - 25));
  const chill = heat / cop * (1 - 0.85 * fc), fan = 0.06 * heat, pump = 0.04 * heat * (1 - 0.5 * fc);
  const misc = 0.015 * it + 0.012 * upsIn + 0.01 * it;
  const cool = live ? chill + fan + pump : 0, total = upsIn + cool + misc;
  return { it, eff, upsIn, upsLoss, chill, fan, pump, misc, cool, heat, total, pue: total / it, f, fc, cop };
}

function step(dt) {
  S.t += dt; S.tot += dt;
  if (S.grid) { S.gG += dt; S.gB = 0; } else { S.gB += dt; S.gG = 0; }
  if (S.surge > 0) S.surge -= dt;
  const base = S.it + (S.surge > 0 ? 900 : 0);

  // Genset State Engine
  if (!S.grid && S.gB > 1 && S.gs === 'OFF') {
    S.gs = 'CRANK'; S.gT = 0;
    log('Utility loss detected. Genset START command issued', 'var(--warn)');
  }
  if (S.gs === 'CRANK') {
    S.gT += dt;
    if (S.gT > 5) {
      if (S.gf) {
        S.gs = 'FAULT';
        log('Genset FAILED TO START (3 crank attempts exhausted)', 'var(--bad)');
      } else {
        S.gs = 'WARM'; S.gT = 0;
        log('Genset cranked, building nominal voltage & frequency', 'var(--mu)');
      }
    }
  } else if (S.gs === 'WARM') {
    S.gT += dt;
    if (S.gT > 4) {
      S.gs = 'RUN';
      log('Genset at rated 415 V / 50 Hz, ready to accept critical load', 'var(--ok)');
    }
  } else if (S.gs === 'COOL') {
    S.gT += dt;
    if (!S.grid) S.gs = 'RUN';
    else if (S.gT > 15) {
      S.gs = 'OFF';
      log('Genset cooldown cycle complete, diesel engine stopped', 'var(--mu)');
    }
  } else if (S.gs === 'FAULT' && !S.gf) {
    S.gs = 'OFF';
  }
  if (S.gs === 'RUN' && S.grid && S.ats === 'UTIL') {
    S.gs = 'COOL'; S.gT = 0;
  }
  const ready = S.gs === 'RUN';

  // ATS Automatic Transfer Switch Engine
  let want;
  if (S.ats === 'UTIL') want = S.gB > 0.5 ? (ready ? 'GEN' : 'OPEN') : 'UTIL';
  else want = (S.grid && S.gG > 20) ? 'UTIL' : (ready ? 'GEN' : 'OPEN');

  if (want !== S.ats) {
    if (S.ats !== 'OPEN') {
      S.ats = 'OPEN'; S.gap = 0;
      log('ATS opened (break-before-make mechanical interlock active)', 'var(--warn)');
    } else {
      S.gap += dt;
      if (S.gap >= 0.3) {
        S.ats = want; S.tr++;
        log('ATS closed to ' + want + (want === 'GEN' ? ' (critical load on genset)' : ' (retransfer to utility, grid stable 20 s)'), 'var(--ok)');
        if (want === 'UTIL' && S.gs === 'RUN') {
          S.gs = 'COOL'; S.gT = 0;
        }
      }
    }
  }
  const live = S.ats === 'UTIL' ? S.grid : S.ats === 'GEN' ? ready : false;

  // Double-Conversion Online UPS Engine
  const sp = setpoint(base);
  let M = model(sp, base, S.um, live);
  const f = M.f;
  const lim = f > 1.5 ? 0.1 : f > 1.25 ? 10 : f > 1.05 ? 60 : Infinity;

  if (f > 1.05 && S.ok) {
    S.ov += dt; S.ovl = true;
    if (S.ov > lim) {
      if (S.um === 'ONLINE' && live) {
        S.um = 'BYPASS';
        log(`UPS overload ${(f * 100).toFixed(0)}%: zero-break transfer to STATIC BYPASS`, 'var(--bad)');
      } else if (S.um === 'BATT') {
        S.um = 'OFF'; S.ok = false;
        log('Overload on battery: inverter protective trip, LOAD DROPPED', 'var(--bad)');
      }
    }
  } else {
    S.ov = Math.max(0, S.ov - dt * 2);
    S.ovl = f > 1.05;
  }

  if (S.um === 'BYPASS') {
    if (f < 0.95) S.ovc += dt; else S.ovc = 0;
    if (S.ovc > 5 && live) {
      S.um = 'ONLINE'; S.ovc = 0;
      log('Overload cleared: inverter resumes normal double conversion', 'var(--ok)');
    }
    if (!live) {
      S.um = 'OFF'; S.ok = false;
      log('Static bypass source lost: LOAD DROPPED', 'var(--bad)');
    }
  } else if (live) {
    if (S.um === 'BATT' || S.um === 'OFF') {
      S.um = 'ONLINE';
      if (!S.ok) log('Power source restored: UPS restarted, critical load re-energized', 'var(--ok)');
      S.ok = true;
      log('UPS online on mains, battery float charging initiated', 'var(--ok)');
    }
  } else if (S.um === 'ONLINE') {
    S.um = 'BATT';
    log('Utility mains lost: UPS inverter on BATTERY, 0 ms transfer break', 'var(--warn)');
  }

  if (S.um === 'BATT') {
    S.soc -= (M.it / 0.95) * dt / 3600 / BATT_KWH * 100;
    if (S.soc <= 0) {
      S.soc = 0; S.um = 'OFF'; S.ok = false;
      log('Battery bank exhausted: CRITICAL LOAD DROPPED', 'var(--bad)');
    }
  }

  if (live && S.um === 'ONLINE' && S.soc < 100) {
    S.soc = Math.min(100, S.soc + 100 * dt / 3600 / BATT_KWH * 100);
  }

  M = model(sp, base, S.um, live);
  const itP = S.ok ? M.it : 0;
  const total = live ? (S.ok ? M.upsIn + M.cool + M.misc : M.cool + M.misc * 0.3) : 0;

  // Hall Thermal Inertia Model
  if (live) S.roomT += (sp + 1 - S.roomT) * 0.05 * dt * 3;
  else S.roomT += M.heat / 1000 * 0.05 * dt;

  if (S.roomT > 35 && S.ok) {
    S.ok = false; S.um = 'OFF';
    log('Thermal runaway trip: server room exceeded 35 °C safe envelope', 'var(--bad)');
  }

  const genKW = S.ats === 'GEN' ? total : 0, utKW = S.ats === 'UTIL' && S.grid ? total : 0;
  if (S.gs === 'RUN' || S.gs === 'WARM') {
    S.fuel -= (genKW * 0.26 + 30) * dt / 3600 / 8000 * 100;
  }
  if (genKW > GEN_KW && !S.gOv) {
    S.gOv = true;
    log('Genset overload capacity exceeded: consider shedding non-critical cooling', 'var(--bad)');
  }
  if (genKW < GEN_KW) S.gOv = false;

  S.up += S.ok ? dt : 0;
  S.eIT += itP * dt / 3600;
  S.eT += total * dt / 3600;

  const gk = S.ats === 'GEN' ? total : 0, uk = S.ats === 'UTIL' ? total : 0, dl = gk * 0.27 * dt / 3600;
  S.dl = (S.dl || 0) + dl;
  S.cost = (S.cost || 0) + uk * dt / 3600 * 7.5 + dl * 92;
  S.co2 = (S.co2 || 0) + uk * dt / 3600 * 0.71 + dl * 2.68;

  S.m = { M, sp, itP, total, live, genKW, utKW, base, bl: model(18, base, S.um === 'BYPASS' ? 'BYPASS' : 'ONLINE', true) };

  if (S.drill > 0) {
    S.drill -= dt;
    if (S.drill <= 0) {
      S.grid = true;
      log('Outage drill completed: utility grid re-energized', 'var(--ok)');
    }
  }

  if (Math.floor(S.t) !== Math.floor(S.t - dt)) {
    const m = S.m;
    H.p.push([itP, utKW, genKW, live ? M.cool : 0]);
    H.q.push([live && S.ok ? m.total / itP : null, m.bl.pue]);
    H.b.push([S.soc, S.roomT * 2]);
    for (const a of Object.values(H)) if (a.length > 300) a.shift();
  }
}

function chart(cv, data, cols, ymin, ymax) {
  if (!cv) return;
  const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { width: 600, height: 190 };
  const d = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
  cv.width = r.width * d;
  cv.height = r.height * d;
  const x = cv.getContext('2d');
  if (!x) return;
  if (x.scale) x.scale(d, d);
  const w = r.width, h = r.height;
  const cs = typeof getComputedStyle !== 'undefined' ? getComputedStyle(document.documentElement) : { getPropertyValue: () => '#fff' };

  if (x.clearRect) x.clearRect(0, 0, w, h);

  // Background Reticle Grid
  const bdCol = cs.getPropertyValue ? cs.getPropertyValue('--bd').trim() : 'rgba(255,255,255,0.08)';
  const muCol = cs.getPropertyValue ? cs.getPropertyValue('--mu').trim() : '#94a3b8';
  x.strokeStyle = bdCol || 'rgba(255,255,255,0.08)';
  x.fillStyle = muCol || '#94a3b8';
  x.font = '10px "JetBrains Mono", ui-monospace, monospace, sans-serif';
  x.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = h - 18 - (h - 26) * i / 4;
    x.beginPath();
    x.moveTo(34, y);
    x.lineTo(w, y);
    x.stroke();
    x.fillText((ymin + (ymax - ymin) * i / 4).toFixed(ymax < 5 ? 2 : 0), 2, y + 3);
  }

  cols.forEach((c, si) => {
    const colorStr = (cs.getPropertyValue ? cs.getPropertyValue(c).trim() : '') || c;
    x.strokeStyle = colorStr;
    x.lineWidth = 2;
    x.lineJoin = 'round';
    x.lineCap = 'round';
    x.beginPath();
    let st = false;
    data.forEach((p, i) => {
      const v = p[si];
      if (v == null) { st = false; return; }
      const X = 34 + (w - 38) * i / 299;
      const Y = h - 18 - (h - 26) * clamp((v - ymin) / (ymax - ymin), 0, 1);
      if (st) x.lineTo(X, Y); else x.moveTo(X, Y);
      st = true;
    });
    x.stroke();
  });
}

const pillSet = (id, t, c) => {
  const e = $(id);
  if (!e) return;
  e.textContent = t;
  e.className = 'pill ' + c;
};

function render() {
  const m = S.m;
  if (!m) return;
  const { M } = m;

  const u = S.up / S.tot * 100;
  if ($('hUp')) {
    $('hUp').textContent = u.toFixed(u > 99.99 ? 0 : 2) + '%';
    $('hUp').style.color = u > 99.9 ? 'var(--ok)' : 'var(--bad)';
  }
  if ($('hBase')) $('hBase').textContent = m.bl.pue.toFixed(2);
  if ($('hCur')) $('hCur').textContent = (m.M.pue).toFixed(2);

  if ($('kIT')) $('kIT').innerHTML = m.itP.toFixed(0) + ' <small>kW</small>';
  pillSet('pLoad', S.ok ? 'ENERGIZED' : 'DROPPED', S.ok ? 'ok' : 'bad');

  if ($('kPUE')) $('kPUE').textContent = S.ok && m.total > 0 ? (m.total / m.itP).toFixed(3) : 'n/a';
  if ($('kCum')) $('kCum').textContent = S.eIT > 0 ? (S.eT / S.eIT).toFixed(3) : '1.000';
  if ($('kSP')) $('kSP').textContent = m.sp;

  if ($('kUPS')) $('kUPS').innerHTML = (M.f * 100).toFixed(0) + ' <small>% load</small>';
  if ($('bSoc')) {
    $('bSoc').style.width = S.soc + '%';
    $('bSoc').style.background = S.soc < 30 ? 'var(--bad)' : S.soc < 60 ? 'var(--warn)' : 'var(--ok)';
  }
  if ($('kSoc')) $('kSoc').textContent = S.soc.toFixed(1);
  if ($('kEff')) $('kEff').textContent = (M.eff * 100).toFixed(1);
  if ($('kOv')) $('kOv').textContent = S.ovl ? `OVERLOAD timer ${S.ov.toFixed(0)} s` : 'no overload';

  if ($('kGen')) $('kGen').textContent = S.gs;
  if ($('kFuel')) $('kFuel').textContent = Math.max(0, S.fuel).toFixed(1);
  if ($('kRoom')) $('kRoom').textContent = S.roomT.toFixed(1);
  if ($('kTr')) $('kTr').textContent = S.tr;

  // Single-Line Diagram Nodes
  if ($('tU')) $('tU').textContent = S.grid ? '415 V OK' : 'OUTAGE';
  if ($('bU')) $('bU').setAttribute('class', 'box ' + (S.grid ? 'a' : 'x'));

  if ($('tG')) $('tG').textContent = S.gs;
  if ($('bG')) $('bG').setAttribute('class', 'box ' + (S.gs === 'RUN' ? 'g' : S.gs === 'FAULT' ? 'x' : ''));

  if ($('tA')) $('tA').textContent = S.ats;
  if ($('bA')) $('bA').setAttribute('class', 'box ' + (S.ats === 'OPEN' ? 'x' : S.ats === 'GEN' ? 'g' : 'a'));

  if ($('tP')) $('tP').textContent = S.um;
  if ($('bP')) $('bP').setAttribute('class', 'box ' + (S.um === 'ONLINE' ? 'a' : S.um === 'OFF' ? 'x' : 'g'));

  if ($('tB')) $('tB').textContent = S.soc.toFixed(0) + '%';
  if ($('tI')) $('tI').textContent = m.itP.toFixed(0) + ' kW';
  if ($('bI')) $('bI').setAttribute('class', 'box ' + (S.ok ? 'a' : 'x'));

  if ($('tC')) $('tC').textContent = 'Cooling ' + (m.live ? M.cool.toFixed(0) + ' kW' : 'OFF');

  if ($('kU')) $('kU').textContent = m.utKW ? m.utKW.toFixed(0) + ' kW' : '';
  if ($('kG')) $('kG').textContent = m.genKW ? m.genKW.toFixed(0) + ' kW' : '';

  // Single-Line Diagram Lines
  const L = (id, c) => { if ($(id)) $(id).setAttribute('class', 'ln ' + c); };
  L('lU', S.ats === 'UTIL' && S.grid ? 'on' : '');
  L('lG', S.ats === 'GEN' ? 'gn' : '');
  L('lA', m.live ? (S.ats === 'GEN' ? 'gn' : 'on') : '');
  L('lUPS', S.ok ? (S.um === 'BATT' ? 'bt' : 'on') : '');
  L('lC', m.live ? (S.ats === 'GEN' ? 'gn' : 'on') : '');
  L('lB', S.um === 'BATT' ? 'bt' : (m.live && S.soc < 100 ? 'on' : ''));

  // PUE Breakdown
  const parts = [
    ['IT Workload', m.itP, '--it'],
    ['UPS Loss', (S.ok ? M.upsLoss : 0), '--warn'],
    ['Chiller Plant', m.live ? M.chill : 0, '--ac'],
    ['CRAC Fans', m.live ? M.fan : 0, '--ok'],
    ['Pumps', m.live ? M.pump : 0, '--ok'],
    ['Misc/PDU/Xfmr', M.misc, '--mu']
  ];
  if ($('brk')) {
    $('brk').innerHTML = parts.map(p => `<div><span class="lab"><i style="display:inline-block;width:9px;height:9px;background:var(${p[2]});margin-right:5px;border-radius:2px"></i>${p[0]}</span><div class="kpi" style="font-size:18px">${p[1].toFixed(0)} <small>kW</small></div></div>`).join('') +
      `<div><span class="lab">Chiller COP / Free Cool</span><div class="kpi" style="font-size:18px">${M.cop.toFixed(2)} <small>/ ${(M.fc * 100).toFixed(0)}%</small></div></div>`;
  }

  extra(m, M);
  scope(m);

  chart($('c1'), H.p, ['--it', '--ac', '--gen', '--ok'], 0, 3000);
  chart($('c2'), H.q, ['--ok', '--warn'], 1, 2);
  chart($('c3'), H.b, ['--warn', '--bad'], 0, 100);
}

const SEQ = ['Normal Mains', 'Outage Sensed', 'Genset Starting', 'ATS Transfer', 'Islanded on Genset', 'Utility Restored', 'Retransfer Stable', 'Cooldown & Stop'];
const inr = v => '₹' + Math.round(v).toLocaleString('en-IN');

function extra(m, M) {
  let i = 0;
  if (S.gs === 'FAULT') i = -1;
  else if (S.ats === 'GEN' && S.grid) i = 5;
  else if (S.ats === 'GEN') i = 4;
  else if (S.ats === 'OPEN' && S.grid) i = 6;
  else if (S.ats === 'OPEN' && S.gs === 'RUN') i = 3;
  else if (S.gs === 'CRANK' || S.gs === 'WARM') i = 2;
  else if (!S.grid) i = 1;
  else if (S.gs === 'COOL') i = 7;

  if ($('seq')) {
    $('seq').innerHTML = SEQ.map((s, j) => `<span class="st${j === i ? ' now' : ''}">${j + 1}. ${s}</span>`).join('') + (i < 0 ? '<span class="st bad2">GENSET FAULT</span>' : '');
  }

  const bm = S.soc / 100 * BATT_KWH / (M.it / 0.95) * 60;
  const fh = Math.max(0, S.fuel) / 100 * 8000 / (Math.max(m.total, 600) * 0.26);

  const N = {
    '0': `All power sources nominal. Utility grid feeds the ATS, the UPS rectifier carries the 2 MW IT load and maintains battery float charge. Diesel genset in hot standby. Facility overhead: ${(M.total - M.it).toFixed(0)} kW (cooling + conversion losses) on ${M.it.toFixed(0)} kW IT.`,
    '1': `Utility grid lost. Double-conversion UPS inverter instantly draws power from the battery bank with ZERO transfer gap (0 ms). ATS controller begins confirmation timing. Battery runtime at this load: ${bm.toFixed(0)} min.`,
    '2': `Genset diesel engine cranking; alternator building nominal 415 V / 50 Hz. IT hall runs uninterrupted on UPS battery bank (${S.soc.toFixed(0)}% SoC, ~${bm.toFixed(1)} min runtime). Vulnerable start window active.`,
    '3': `Genset at rated voltage and synchronism. ATS opens utility feed and prepares connection to genset across a 0.3 s break-before-make mechanical interlock, preventing any back-feed into utility mains.`,
    '4': `Genset carries the entire facility load: ${m.genKW.toFixed(0)} kW of 2500 kW capacity (${(m.genKW / GEN_KW * 100).toFixed(0)}% load factor). Battery bank commences float recharge. Diesel autonomy: ${fh.toFixed(1)} hours.`,
    '5': `Utility grid voltage restored. ATS initiates a 20 s stability validation timer to ensure grid quality before initiating retransfer.`,
    '6': `ATS retransferring facility back to utility mains through break-before-make open transition. UPS battery seamlessly carries the IT critical bus through the transition gap.`,
    '7': `Utility powering the facility. Genset running unloaded on a turbocharger cooldown cycle before automated stop.`,
    '-1': `CRITICAL FAULT: Genset failed to start after 3 crank cycles. UPS battery bank is the sole remaining line of defense (~${bm.toFixed(1)} min runtime remaining). Restore utility feed or initiate emergency load shedding immediately!`
  };

  let t = N[i];
  if (S.um === 'BYPASS') t += ' ATTENTION: UPS is on static bypass following an overload event; IT bus is currently exposed to raw source voltage transients.';
  if (!S.ok) t = 'CRITICAL OUTAGE: LOAD LOST. IT critical bus is de-energized. In a real data center this constitutes a catastrophic Sev-1 SLA breach.';

  if ($('nar')) {
    $('nar').textContent = t;
    $('nar').className = 'nar' + (!S.ok || i < 0 ? ' bd' : '');
  }

  const cur = model(m.sp, m.base, S.um === 'BYPASS' ? 'BYPASS' : 'ONLINE', true);
  const dk = m.bl.total - cur.total;

  if ($('bCost')) $('bCost').textContent = inr(S.cost || 0);
  if ($('bDsl')) $('bDsl').textContent = (S.dl || 0).toFixed(0) + ' L';
  if ($('bCo2')) $('bCo2').textContent = (S.co2 || 0).toFixed(0) + ' kg';
  if ($('bBat')) $('bBat').textContent = bm.toFixed(0) + ' min';
  if ($('bFu')) $('bFu').textContent = fh.toFixed(1) + ' h';
  if ($('bDn')) $('bDn').textContent = (S.tot - S.up).toFixed(0) + ' s';
  if ($('bSv')) $('bSv').textContent = (dk * 8760 * 7.5 / 1e7).toFixed(2) + ' crore';
  if ($('bCv')) $('bCv').textContent = (dk * 8760 * 0.71 / 1000).toFixed(0) + ' t';

  const gf = S.ats === 'GEN' ? 50 - 0.25 * m.genKW / GEN_KW : S.ats === 'UTIL' && S.grid ? 50 + Math.sin(S.t * 0.7) * 0.03 : null;
  if ($('rU')) $('rU').textContent = S.grid ? (415 + Math.sin(S.t) * 2).toFixed(0) : '0';
  if ($('rB')) $('rB').textContent = S.ok ? '415' : '0';
  if ($('rF')) $('rF').textContent = gf ? gf.toFixed(2) : '---';
  if ($('rI')) $('rI').textContent = (m.itP * 1000 / (1.732 * 415 * 0.97)).toFixed(0);
}

function scope(m) {
  const cv = $('c4');
  if (!cv) return;
  const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { width: 600, height: 155 };
  const d = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
  cv.width = r.width * d;
  cv.height = r.height * d;
  const x = cv.getContext('2d');
  if (!x) return;
  if (x.scale) x.scale(d, d);
  const w = r.width, h = r.height;
  const cs = typeof getComputedStyle !== 'undefined' ? getComputedStyle(document.documentElement) : { getPropertyValue: () => '#fff' };
  const now = typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
  const ph = now / 350;

  if (x.clearRect) x.clearRect(0, 0, w, h);

  // Oscilloscope CRT Graticule Grid
  const bdCol = cs.getPropertyValue ? cs.getPropertyValue('--bd').trim() : 'rgba(255,255,255,0.08)';
  x.strokeStyle = bdCol || 'rgba(255,255,255,0.08)';
  x.lineWidth = 0.8;

  // Horizontal divisions
  for (let div = 1; div < 6; div++) {
    const gy = h * (div / 6);
    x.beginPath();
    x.moveTo(0, gy);
    x.lineTo(w, gy);
    x.stroke();
  }

  // Vertical divisions
  for (let div = 1; div < 8; div++) {
    const gx = w * (div / 8);
    x.beginPath();
    x.moveTo(gx, 0);
    x.lineTo(gx, h);
    x.stroke();
  }

  // Phosphor waveform drawing
  const tr = (amp, yc, col) => {
    const colorStr = (cs.getPropertyValue ? cs.getPropertyValue(col).trim() : '') || col;
    if (x.save) x.save();
    if (x.shadowBlur !== undefined) {
      x.shadowBlur = 6;
      x.shadowColor = colorStr;
    }
    x.strokeStyle = colorStr;
    x.lineWidth = 2.2;
    x.beginPath();
    for (let p = 0; p <= w; p += 2) {
      const y = yc - amp * Math.sin((p / w) * 6 * Math.PI - ph);
      if (p) x.lineTo(p, y); else x.moveTo(p, y);
    }
    x.stroke();
    if (x.restore) x.restore();
  };

  // Center reference baselines
  [h * 0.27, h * 0.75].forEach(y => {
    x.beginPath();
    x.moveTo(0, y);
    x.lineTo(w, y);
    x.stroke();
  });

  tr(S.grid ? h * 0.2 : 0, h * 0.27, S.grid ? '--ac' : '--bad');
  tr(S.ok ? h * 0.2 : 0, h * 0.75, S.ok ? '--ok' : '--bad');
}

// Sliders and Inputs
if ($('it')) $('it').oninput = e => { S.it = +e.target.value; if ($('itV')) $('itV').textContent = S.it; };
if ($('sp')) $('sp').oninput = e => { if ($('spV')) $('spV').textContent = e.target.value; };
if ($('amb')) $('amb').oninput = e => { if ($('ambV')) $('ambV').textContent = e.target.value; };

// Action Buttons
if ($('bFail')) $('bFail').onclick = () => { if (S.grid) { S.grid = false; log('GRID FAILURE injected: utility blackout triggered', 'var(--bad)'); } };
if ($('bRest')) $('bRest').onclick = () => { if (!S.grid) { S.grid = true; S.drill = 0; log('Utility mains restored: 20 s stability verification timer running', 'var(--ok)'); } };
if ($('bDrill')) $('bDrill').onclick = () => { S.grid = false; S.drill = 90; log('Standard 90 s full outage drill initiated', 'var(--bad)'); };
if ($('bGF')) $('bGF').onclick = () => {
  S.gf = !S.gf;
  if ($('gfT')) $('gfT').textContent = S.gf ? 'ON' : 'off';
  $('bGF').classList.toggle('on', S.gf);
};
if ($('bSurge')) $('bSurge').onclick = () => { S.surge = 20; log('IT surge +900 kW injected for 20 s (UPS overload test)', 'var(--warn)'); };
if ($('bReset')) $('bReset').onclick = () => {
  S = S0(); H = { p: [], q: [], b: [] }; logs = [];
  if ($('log')) $('log').innerHTML = '';
  if ($('gfT')) $('gfT').textContent = 'off';
  if ($('bGF')) $('bGF').classList.remove('on');
  log('System reset to nominal 2 MW reference conditions', 'var(--ok)');
};

// Speed Selector
document.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => {
  speed = +b.dataset.sp;
  document.querySelectorAll('[data-sp]').forEach(x => x.classList.toggle('on', x === b));
});

// Theme Switcher
const themes = ['dark', 'light', 'cyber'];
let curThemeIdx = 0;
function setTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem('dc_sim_theme', name); } catch (e) {}
  }
  const icons = { dark: '🌙', light: '☀️', cyber: '🔮' };
  if ($('themeIcon')) $('themeIcon').textContent = icons[name] || '🎨';
  if ($('themeText')) $('themeText').textContent = name.charAt(0).toUpperCase() + name.slice(1);
}

if ($('themeToggle')) {
  $('themeToggle').onclick = () => {
    curThemeIdx = (curThemeIdx + 1) % themes.length;
    setTheme(themes[curThemeIdx]);
  };
}

if (typeof localStorage !== 'undefined') {
  try {
    const saved = localStorage.getItem('dc_sim_theme');
    if (saved && themes.includes(saved)) {
      curThemeIdx = themes.indexOf(saved);
      setTheme(saved);
    }
  } catch (e) {}
}

// Preset Scenarios
const glob = typeof window !== 'undefined' ? window : globalThis;
glob.runPreset = function (p) {
  if (p === 'drill') {
    if ($('bDrill')) $('bDrill').click();
  } else if (p === 'genfault') {
    if (!S.gf && $('bGF')) $('bGF').click();
    if (S.grid && $('bFail')) $('bFail').click();
  } else if (p === 'surge') {
    if ($('bSurge')) $('bSurge').click();
  } else if (p === 'heatwave') {
    if ($('amb')) { $('amb').value = 38; $('amb').dispatchEvent(new Event('input')); }
    if ($('it')) { $('it').value = 1800; $('it').dispatchEvent(new Event('input')); }
    log('Scenario: Extreme Summer Heatwave (38 °C ambient, 1.8 MW IT workload)', 'var(--warn)');
  } else if (p === 'ecocool') {
    if ($('amb')) { $('amb').value = 10; $('amb').dispatchEvent(new Event('input')); }
    if ($('strat')) { $('strat').value = 'ADAPT'; }
    if ($('it')) { $('it').value = 1200; $('it').dispatchEvent(new Event('input')); }
    log('Scenario: Waterside Economizer Free-Cooling Mode (10 °C ambient)', 'var(--ok)');
  } else if (p === 'nominal') {
    if ($('bReset')) $('bReset').click();
  }
};

// Initial Log and Loop
log('Nominal operation: Utility mains feeding ATS, UPS online, diesel genset in hot standby');
setInterval(() => {
  for (let i = 0; i < speed; i++) step(0.1);
  render();
}, 100);

for (let i = 0; i < 30; i++) step(1);
S.up = S.tot = 1;
render();
