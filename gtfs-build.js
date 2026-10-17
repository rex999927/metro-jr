#!/usr/bin/env node
// Převod PID GTFS (složka s rozbalenými .txt) -> kompaktní jr.bin.gz pro vyhledávač spojení v aplikaci.
// Použití: node gtfs-build.js <složka-gtfs> [výstup.jr.bin.gz]
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const dir = process.argv[2];
const out = process.argv[3] || 'jr.bin.gz';
if (!dir) { console.log('Použití: node gtfs-build.js <složka-gtfs> [výstup]'); process.exit(1); }

function parseLine(l) {
  if (l.indexOf('"') < 0) return l.split(',');
  const r = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(cur); cur = ''; }
    else cur += c;
  }
  r.push(cur); return r;
}
function rows(name, fn) {
  const txt = fs.readFileSync(path.join(dir, name), 'utf8');
  let pos = 0, hdr = null;
  while (pos < txt.length) {
    let e = txt.indexOf('\n', pos); if (e < 0) e = txt.length;
    let line = txt.slice(pos, e); pos = e + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) continue;
    const f = parseLine(line);
    if (!hdr) { hdr = {}; f.forEach((h, i) => hdr[h.replace(/^﻿/, '')] = i); continue; }
    fn(f, hdr);
  }
}
const sec = s => { const p = s.split(':'); return (+p[0]) * 3600 + (+p[1]) * 60 + (+p[2]); };
const ymd = d => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
const fmt = dt => dt.toISOString().slice(0, 10).replace(/-/g, '');

// ---- služby -> bitmasky dnů
let dMin = '99999999', dMax = '0';
rows('feed_info.txt', (f, h) => { dMin = f[h.feed_start_date]; dMax = f[h.feed_end_date]; });
const d0 = ymd(dMin); let nd = Math.round((ymd(dMax) - d0) / 864e5) + 1; if (nd > 31) nd = 31;
const dayIdx = d => { const i = Math.round((ymd(d) - d0) / 864e5); return i >= 0 && i < nd ? i : -1; };
const svcMask = {};
rows('calendar.txt', (f, h) => {
  const wd = [f[h.sunday], f[h.monday], f[h.tuesday], f[h.wednesday], f[h.thursday], f[h.friday], f[h.saturday]];
  let m = 0;
  for (let i = 0; i < nd; i++) {
    const dt = new Date(d0.getTime() + i * 864e5), ds = fmt(dt);
    if (ds >= f[h.start_date] && ds <= f[h.end_date] && wd[dt.getUTCDay()] === '1') m |= (1 << i);
  }
  svcMask[f[h.service_id]] = m;
});
rows('calendar_dates.txt', (f, h) => {
  const i = dayIdx(f[h.date]); if (i < 0) return;
  const s = f[h.service_id]; if (svcMask[s] === undefined) svcMask[s] = 0;
  if (f[h.exception_type] === '1') svcMask[s] |= (1 << i); else svcMask[s] &= ~(1 << i);
});
const masks = [], maskIdx = new Map();
const svcOf = {};
for (const s in svcMask) { const m = svcMask[s] | 0; if (!maskIdx.has(m)) { maskIdx.set(m, masks.length); masks.push(m); } svcOf[s] = maskIdx.get(m); }

// ---- linky
const routes = [], routeIdx = {};
rows('routes.txt', (f, h) => { routeIdx[f[h.route_id]] = routes.length; routes.push([f[h.route_short_name], +f[h.route_type], f[h.route_color] || '']); });

// ---- zastávky
const stopRows = {}; // stop_id -> {name, lat, lon, node}
rows('stops.txt', (f, h) => {
  if (f[h.location_type] !== '0' && f[h.location_type] !== '') return;
  const id = f[h.stop_id]; let node = f[h.asw_node_id];
  stopRows[id] = { name: f[h.stop_name], lat: +f[h.stop_lat], lon: +f[h.stop_lon], node: node ? +node : 0, plat: f[h.platform_code] || '', zone: f[h.zone_id] || '' };
});

// ---- trips
const trips = {}; // trip_id -> {r, s, hs, st:[]}
const hsTab = [], hsIdx = new Map();
const hsId = s => { if (!hsIdx.has(s)) { hsIdx.set(s, hsTab.length); hsTab.push(s); } return hsIdx.get(s); };
rows('trips.txt', (f, h) => {
  const s = svcOf[f[h.service_id]]; if (s === undefined) return;
  trips[f[h.trip_id]] = { r: routeIdx[f[h.route_id]], s, hs: hsId(f[h.trip_headsign] || ''), st: [] };
});
let nST = 0;
rows('stop_times.txt', (f, h) => {
  const t = trips[f[h.trip_id]]; if (!t) return;
  const sid = f[h.stop_id]; if (!stopRows[sid]) return;
  t.st.push([+f[h.stop_sequence], sid, sec(f[h.arrival_time]), sec(f[h.departure_time]), +f[h.pickup_type], +f[h.drop_off_type]]);
  nST++;
});
// ---- vzory (patterns)
const stopIdx = {}, stopList = [];
const pats = new Map();
for (const id in trips) {
  const t = trips[id]; if (t.st.length < 2) continue;
  t.st.sort((a, b) => a[0] - b[0]);
  let key = t.r + '|';
  for (const x of t.st) {
    if (stopIdx[x[1]] === undefined) { stopIdx[x[1]] = stopList.length; stopList.push(x[1]); }
    key += stopIdx[x[1]] + (x[4] === 1 ? 'n' : '') + (x[5] === 1 ? 'x' : '') + ',';
  }
  let p = pats.get(key);
  if (!p) { p = { r: t.r, st: t.st.map(x => stopIdx[x[1]]), fl: t.st.map(x => (x[4] === 1 ? 1 : 0) | (x[5] === 1 ? 2 : 0)), trips: [] }; pats.set(key, p); }
  p.trips.push(t);
}
// ---- binární část
const bytes = []; 
function vu(n) { while (n >= 128) { bytes.push((n & 127) | 128); n = Math.floor(n / 128); } bytes.push(n); }
function vz(n) { vu(n < 0 ? -n * 2 - 1 : n * 2); }
const plist = [...pats.values()];
vu(plist.length);
for (const p of plist) {
  p.trips.sort((a, b) => a.st[0][3] - b.st[0][3]);
  vu(p.r); vu(p.st.length);
  let prev = 0;
  for (let i = 0; i < p.st.length; i++) { vz(p.st[i] - prev); prev = p.st[i]; vu(p.fl[i]); }
  vu(p.trips.length);
  let pt = 0;
  for (const t of p.trips) {
    const st0 = t.st[0][3];
    vu(t.s); vu(t.hs); vz(st0 - pt); pt = st0;
    let last = st0;
    for (let i = 0; i < t.st.length; i++) {
      const a = Math.max(t.st[i][2], last), d = Math.max(t.st[i][3], a);
      vu(a - last); vu(d - a); last = d;
    }
  }
}
// ---- hlavička
const nameTab = [], nameIdx = new Map();
const nid = s => { if (!nameIdx.has(s)) { nameIdx.set(s, nameTab.length); nameTab.push(s); } return nameIdx.get(s); };
const S = { n: [], la: [], lo: [], nd: [], pl: [], z: [] };
let pla = 0, plo = 0;
for (const id of stopList) {
  const s = stopRows[id];
  S.n.push(nid(s.name));
  const la = Math.round(s.lat * 1e5), lo = Math.round(s.lon * 1e5);
  S.la.push(la - pla); S.lo.push(lo - plo); pla = la; plo = lo;
  S.nd.push(s.node); S.pl.push(s.plat); S.z.push(s.zone);
}
// explicitní přestupy mezi různými zastávkami (type 2)
const fp = [];
rows('transfers.txt', (f, h) => {
  if (f[h.transfer_type] !== '2') return;
  const a = stopIdx[f[h.from_stop_id]], b = stopIdx[f[h.to_stop_id]];
  if (a === undefined || b === undefined || a === b) return;
  fp.push([a, b, +f[h.min_transfer_time] || 0]);
});
const head = { v: 1, d0: fmt(d0), nd, names: nameTab, stops: S, routes, masks, hs: hsTab, fp, feedEnd: dMax, built: new Date().toISOString().slice(0, 10) };
const hb = Buffer.from(JSON.stringify(head), 'utf8');
const pre = Buffer.alloc(4); pre.writeUInt32LE(hb.length, 0);
const all = Buffer.concat([Buffer.from('JR1\0'), pre, hb, Buffer.from(bytes)]);
const gz = zlib.gzipSync(all, { level: 9 });
fs.writeFileSync(out, gz);
fs.writeFileSync(path.join(path.dirname(out), 'jr.meta.json'), JSON.stringify({ v: 1, d0: fmt(d0), feedEnd: dMax, built: head.built, bytes: gz.length }));
console.log('zastávky', stopList.length, 'vzory', plist.length, 'spoje', Object.keys(trips).length, 'stop_times', nST);
console.log('raw', (all.length / 1e6).toFixed(1), 'MB; gz', (gz.length / 1e6).toFixed(2), 'MB; hlavička', (hb.length / 1e6).toFixed(2), 'MB; dny', nd, fmt(d0));
