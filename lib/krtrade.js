'use strict';
// 한국 관세청 품목별 국가별 수출입실적으로 품목별 수입 통관 단가(달러/t)를 계산한다.
// 단가(달러/t) = 수입금액(impDlr, 달러) ÷ 수입중량(impWgt, kg) × 1,000. 중량은 순중량.
// 국가를 지정하지 않고 조회하면 전 국가 행이 오므로 그대로 합산한다. '총계' 행은 기간 전체 합이라 쓰지 않는다.
const { query, serviceKey, SOURCE } = require('./customs');

const KR_ITEMS = [
  { id: 'imp1', prefixes: ['7208'] },
  { id: 'imp2', prefixes: ['7209'] },
  { id: 'imp3', prefixes: ['7210'] },
  { id: 'imp4', prefixes: ['7225'] },
  { id: 'imp5', prefixes: ['7213'] },
  { id: 'imp6', prefixes: ['721420'] },
  { id: 'imp7', prefixes: ['721633'] },
  { id: 'imp8', prefixes: ['7219'] },
  { id: 'imp9', prefixes: ['7204'] }
];
const FOCUS = ['CN', 'JP']; // 국내 유통에서 가장 많이 비교하는 중국산·일본산
const LOW_VOLUME_T = 100;
const DATA_TTL_MS = 12 * 60 * 60 * 1000;
const MONTHS_BACK = 4;
const CONCURRENCY = 3;

function num(v) { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; }
function ymParam(d, back) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
  return x.getUTCFullYear() + String(x.getUTCMonth() + 1).padStart(2, '0');
}
function prevYm(ym) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

function summarize(acc) {
  if (!acc || !(acc.kg > 0)) return { status: 'nodata' };
  const t = acc.kg / 1000;
  return { status: 'ok', unitPrice: Math.round(acc.usd / t * 100) / 100, tons: Math.round(t), valueUsd: Math.round(acc.usd), lowVolume: t < LOW_VOLUME_T };
}

// 행(월 × 국가 × HS) → 월별 합계와 국가별 합계
function aggregate(rows, prefixes) {
  const months = {};
  rows.forEach(r => {
    const m = String(r.year || '').match(/^(\d{4})\.(\d{2})$/);
    if (!m) return; // '총계' 등
    const hs = String(r.hsCd || '');
    if (!prefixes.some(p => hs.startsWith(p))) return;
    const key = m[1] + '-' + m[2];
    const mo = months[key] = months[key] || { kg: 0, usd: 0, byCountry: {} };
    const kg = num(r.impWgt), usd = num(r.impDlr);
    mo.kg += kg; mo.usd += usd;
    const cc = String(r.statCd || '?');
    const c = mo.byCountry[cc] = mo.byCountry[cc] || { kg: 0, usd: 0, name: r.statCdCntnKor1 || cc };
    c.kg += kg; c.usd += usd;
  });
  return months;
}

function monthResult(mo) {
  const base = summarize(mo);
  if (base.status !== 'ok') return base;
  const countries = Object.keys(mo.byCountry).map(k => Object.assign({ code: k }, mo.byCountry[k])).filter(c => c.kg > 0).sort((a, b) => b.kg - a.kg);
  base.topPartners = countries.slice(0, 3).map(c => ({ code: c.code, name: c.name, share: Math.round(c.kg / mo.kg * 1000) / 10 }));
  base.byCountry = {};
  FOCUS.forEach(code => { const c = mo.byCountry[code]; base.byCountry[code] = summarize(c); });
  return base;
}

function createKrTrade(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const now = (opts && opts.now) || (() => new Date());
  const log = (opts && opts.log) || ((m) => console.log(m));
  const cache = new Map();
  const inflight = new Map();

  function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().then(v => { cache.set(key, { value: v, exp: Date.now() + ttl }); inflight.delete(key); return v; },
      e => { inflight.delete(key); throw e; });
    inflight.set(key, p);
    return p;
  }

  async function latest() {
    serviceKey();
    const start = ymParam(now(), MONTHS_BACK), end = ymParam(now(), 0);
    return cached('kr:' + start + ':' + end, DATA_TTL_MS, async () => {
      const tasks = KR_ITEMS.map(it => async () => {
        const rows = [];
        for (const p of it.prefixes) {
          const r = await query({ strtYymm: start, endYymm: end, hsSgn: p }, fetchImpl);
          rows.push(...r.items);
        }
        return aggregate(rows, it.prefixes);
      });
      const res = [];
      for (let i = 0; i < tasks.length; i += CONCURRENCY) res.push(...await Promise.all(tasks.slice(i, i + CONCURRENCY).map(f => f())));
      // 기준 월: 수입 중량이 있는 가장 최근 월(전 품목 공통). 없는 달의 값은 만들지 않는다.
      const all = new Set();
      res.forEach(mo => Object.keys(mo).forEach(k => { if (mo[k].kg > 0) all.add(k); }));
      const month = [...all].sort().pop() || null;
      const pm = month && prevYm(month);
      const items = KR_ITEMS.map((it, i) => {
        if (!month) return { id: it.id, prefixes: it.prefixes, status: 'nodata', prev: { status: 'nodata' } };
        const cur = monthResult(res[i][month]);
        const prev = monthResult(res[i][pm]);
        return Object.assign({ id: it.id, prefixes: it.prefixes }, cur, { prev: { status: prev.status, unitPrice: prev.unitPrice, tons: prev.tons, lowVolume: prev.lowVolume, byCountry: prev.byCountry } });
      });
      log('customs kr-trade month=' + month + ' ok=' + items.filter(x => x.status === 'ok').length + '/' + items.length);
      return { month, prevMonth: pm, source: SOURCE, unit: 'USD/t', items, fetchedAt: new Date().toISOString() };
    });
  }

  return { latest };
}

module.exports = { createKrTrade, aggregate, monthResult, KR_ITEMS };
