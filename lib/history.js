'use strict';
// Felix 자체 시계열. 발표처가 직전 값만 주는 자료(중국 국가통계국, 관세청, 일본 무역통계, 유럽 Comext 등)도
// 매일 한 번 값을 저장해 두면 시간이 갈수록 추이를 그릴 수 있다. 같은 기간 값은 한 번만 저장한다(정정되면 덮어씀).
//  저장소: KV 'hist:v1' = { key: { label, unit, basis, pts: [[period, value, savedDate], ...] } }  (키당 최근 60개)
//  GET /api/history[?keys=cn:hr,krimp:hr]  →  { status, updatedAt, series: { key: { label, unit, basis, pts: [[p, v], ...] } } }
const KEY = 'hist:v1';
const MAX = 60;

// 직전 기간 이름: 'YYYY-MM' → 전월, 'YYYY-MM 상순/중순/하순' → 직전 열흘. 날짜형(환율)은 알 수 없음
function prevPeriodOf(p) {
  let m = String(p).match(/^(\d{4})-(\d{2})$/);
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 2, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  m = String(p).match(/^(\d{4})-(\d{2}) (상순|중순|하순)$/);
  if (m) {
    if (m[3] === '하순') return m[1] + '-' + m[2] + ' 중순';
    if (m[3] === '중순') return m[1] + '-' + m[2] + ' 상순';
    const d = new Date(Date.UTC(+m[1], +m[2] - 2, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + ' 하순';
  }
  return null;
}

function kstDate(d) { return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10); }

function merge(store, rows, today) {
  const out = Object.assign({}, store || {});
  let added = 0, updated = 0;
  rows.forEach(r => {
    if (r.value == null || !isFinite(r.value) || !r.period || r.low) return;
    const s = out[r.key] = out[r.key] ? Object.assign({}, out[r.key]) : { pts: [] };
    s.label = r.regionName + ' ' + r.label; s.unit = r.unit; s.basis = r.basis;
    const pts = s.pts.slice();
    const i = pts.findIndex(p => p[0] === r.period);
    if (i < 0) { pts.push([r.period, r.value, today]); added++; }
    else if (pts[i][1] !== r.value) { pts[i] = [r.period, r.value, today]; updated++; }
    // 직전 값도 있으면(발표처가 준 전기 값) 비어 있을 때만 보탠다 → 첫날부터 2개 점
    const pp = r.prevPeriod || prevPeriodOf(r.period);
    if (r.prev != null && isFinite(r.prev) && pp && !pts.some(p => p[0] === pp)) { pts.push([pp, r.prev, today]); added++; }
    pts.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    s.pts = pts.slice(-MAX);
  });
  return { store: out, added, updated };
}

function createHistory(opts) {
  const kv = opts.kv;
  const now = (opts && opts.now) || (() => new Date());
  let cache = null;
  return {
    async snapshot(rows) {
      const cur = (await kv.get(KEY)) || {};
      const m = merge(cur, rows, kstDate(now()));
      if (m.added || m.updated) { await kv.set(KEY, m.store); cache = null; }
      return { keys: Object.keys(m.store).length, added: m.added, updated: m.updated };
    },
    async get(keys) {
      if (!cache || cache.exp < Date.now()) cache = { v: (await kv.get(KEY)) || {}, exp: Date.now() + 5 * 60000 };
      const all = cache.v, want = keys ? String(keys).split(',').map(s => s.trim()).filter(Boolean) : Object.keys(all);
      const series = {};
      want.forEach(k => { if (all[k]) series[k] = { label: all[k].label, unit: all[k].unit, basis: all[k].basis, pts: all[k].pts.map(p => [p[0], p[1]]) }; });
      return { status: 'ok', count: Object.keys(series).length, series };
    }
  };
}

module.exports = { createHistory, merge, prevPeriodOf };
