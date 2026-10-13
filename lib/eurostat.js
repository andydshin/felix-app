'use strict';
// 유럽 열(국가 비교 표). 키 없음, Eurostat 재사용 정책(출처 표시, EU 데이터).
//  B. Comext DS-045409: EU 역외(EXT) 수입 금액(유로)·수량(100kg) → 유로/t, 품목별  ← 기본
//  A. sts_inppd_m: 국내시장 생산자물가지수(2021=100), NACE 업종별                ← B가 비는 칸 보완
// 응답 형식은 JSON-stat 2.0.

const STATS = process.env.EUROSTAT_BASE || 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';
const COMEXT = process.env.COMEXT_BASE || 'https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data';
const SOURCE = { name: 'Eurostat — Comext (DS-045409) EU 역외 수입, sts_inppd_m 생산자물가지수', credit: 'Source: Eurostat', url: 'https://ec.europa.eu/eurostat' };
const UA = 'Mozilla/5.0 (compatible; FelixDataBot/1.0; steel price research)';
const TTL_MS = 12 * 60 * 60 * 1000;
const LOW_VOLUME_T = 100;

// 품목 → HS 코드(합산), 보완용 NACE 업종
const ITEMS = [
  { id: 'hr', hs: ['7208'], nace: 'C241' }, { id: 'cr', hs: ['7209'], nace: 'C241' }, { id: 'coated', hs: ['7210'], nace: 'C241' },
  { id: 'plate', hs: ['720851', '720852'], nace: 'C241' }, { id: 'wire_rod', hs: ['7213'], nace: 'C241' }, { id: 'rebar', hs: ['721420'], nace: 'C241' },
  { id: 'section', hs: ['7216'], nace: 'C241' }, { id: 'pipe', hs: ['7304', '7305', '7306'], nace: 'C242' }, { id: 'sts', hs: ['7219'], nace: 'C241' },
  { id: 'iron_ore', hs: ['2601'] }, { id: 'coking_coal', hs: ['270112'] }, { id: 'coke', hs: ['2704'], nace: 'C191' },
  { id: 'scrap', hs: ['720441', '720449'] },
  { id: 'al', hs: ['7601'], nace: 'C2442' }, { id: 'cu', hs: ['7403'], nace: 'C2444' }, { id: 'zn', hs: ['7901'], nace: 'C2443' },
  { id: 'ni', hs: ['7502'], nace: 'C2445' }, { id: 'pb', hs: ['7801'], nace: 'C2443' }
];

class EuError extends Error { constructor(status, detail) { super('Eurostat request failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }

// JSON-stat 2.0 → [{ dimValues..., time, value }]
function flatten(js) {
  const ids = js.id || [], size = js.size || [], dims = js.dimension || {};
  const cats = ids.map(id => { const idx = (dims[id] && dims[id].category && dims[id].category.index) || {}; const arr = []; Object.keys(idx).forEach(k => { arr[idx[k]] = k; }); return arr; });
  const strides = size.map((_, i) => size.slice(i + 1).reduce((a, b) => a * b, 1));
  const out = [];
  const vals = js.value || {};
  Object.keys(vals).forEach(k => {
    let n = Number(k); const rec = {};
    ids.forEach((id, i) => { const p = Math.floor(n / strides[i]); n -= p * strides[i]; rec[id] = cats[i][p]; });
    rec.value = vals[k];
    out.push(rec);
  });
  return out;
}

async function getJs(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new EuError(res.status, text.slice(0, 300));
  let js; try { js = JSON.parse(text); } catch (e) { throw new EuError('invalid-json', text.slice(0, 200)); }
  if (js.error) throw new EuError('api', JSON.stringify(js.error).slice(0, 300));
  return js;
}

function qs(params) { const u = new URLSearchParams(); Object.keys(params).forEach(k => [].concat(params[k]).forEach(v => u.append(k, v))); return u.toString(); }
const timeKey = t => String(t).replace(/M/, '-');   // '2026M08' → '2026-08'

// Comext는 lastTimePeriod를 주면 아직 비어 있는 미래 달(예: 2026-10~12)을 고른다 → 시작 달을 지정한다.
function sinceMonth(now, back) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

// B. Comext — 품목별 유로/t (최근 약 6개월에서 금액·수량이 모두 있는 최신·전월)
async function comext(fetchImpl, opts) {
  const o = Object.assign({ reporter: 'EU27_2020', partner: 'EXT_EU27_2020', now: new Date() }, opts || {});
  const products = [...new Set(ITEMS.flatMap(i => i.hs))];
  const url = COMEXT + '/DS-045409?' + qs({ format: 'JSON', freq: 'M', reporter: o.reporter, partner: o.partner, flow: '1', product: products, indicators: ['VALUE_IN_EUROS', 'QUANTITY_IN_100KG'], sinceTimePeriod: sinceMonth(o.now, 6) });
  const recs = flatten(await getJs(url, fetchImpl));
  const by = {}; // product|time → {eur, kg100}
  recs.forEach(r => { const k = r.product + '|' + timeKey(r.time); const b = by[k] = by[k] || { eur: 0, q: 0 }; if (/VALUE/.test(r.indicators)) b.eur += Number(r.value) || 0; if (/QUANTITY/.test(r.indicators)) b.q += Number(r.value) || 0; });
  const months = [...new Set(recs.map(r => timeKey(r.time)))].sort();
  const res = {};
  ITEMS.forEach(it => {
    const at = m => { let eur = 0, q = 0; it.hs.forEach(h => { const b = by[h + '|' + m]; if (b) { eur += b.eur; q += b.q; } }); const t = q / 10; return t > 0 ? { unitPrice: Math.round(eur / t * 100) / 100, tons: Math.round(t), lowVolume: t < LOW_VOLUME_T } : null; };
    // 최신 달은 값이 있는 마지막 달(금액·수량 모두)
    const avail = months.filter(m => at(m));
    const cur = avail[avail.length - 1], prev = avail[avail.length - 2];
    res[it.id] = cur ? Object.assign({ status: 'ok', period: cur }, at(cur), { prev: prev ? Object.assign({ period: prev }, at(prev)) : null }) : { status: 'nodata' };
  });
  return { months, items: res, url: url.replace(COMEXT, '') };
}

// A. PPI — NACE 업종별 지수(2021=100) 최신·전월
async function ppi(fetchImpl) {
  const naces = [...new Set(ITEMS.map(i => i.nace).filter(Boolean))];
  const url = STATS + '/sts_inppd_m?' + qs({ format: 'JSON', lang: 'EN', geo: 'EU27_2020', unit: 'I21', s_adj: 'NSA', nace_r2: naces, lastTimePeriod: '3' });
  const recs = flatten(await getJs(url, fetchImpl)).filter(r => r.value != null);
  const res = {};
  naces.forEach(n => {
    const s = recs.filter(r => r.nace_r2 === n).map(r => ({ ym: timeKey(r.time), v: Number(r.value) })).sort((a, b) => a.ym.localeCompare(b.ym));
    if (s.length) { const cur = s[s.length - 1], prev = s[s.length - 2]; res[n] = { period: cur.ym, value: cur.v, prev: prev ? prev.v : null }; }
  });
  return { items: res, url: url.replace(STATS, '') };
}

function createEurostat(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const log = (opts && opts.log) || ((m) => console.log(m));
  const now = (opts && opts.now) || (() => new Date());
  let cache = null;

  async function latest() {
    if (cache && cache.exp > Date.now()) return cache.value;
    const [c, p] = await Promise.allSettled([comext(fetchImpl, { now: now() }), ppi(fetchImpl)]);
    if (c.status !== 'fulfilled' && p.status !== 'fulfilled') throw new EuError('both-failed', (c.reason && c.reason.message) + ' / ' + (p.reason && p.reason.message));
    const cx = c.status === 'fulfilled' ? c.value.items : {}, px = p.status === 'fulfilled' ? p.value.items : {};
    const items = {};
    ITEMS.forEach(it => { items[it.id] = { comext: cx[it.id] || { status: 'nodata' }, ppi: it.nace && px[it.nace] ? Object.assign({ nace: it.nace }, px[it.nace]) : null }; });
    const month = Object.values(cx).filter(x => x.status === 'ok').map(x => x.period).sort().pop() || null;
    const ppiMonth = Object.values(px).map(x => x.period).sort().pop() || null;
    log('eurostat comext=' + month + ' ppi=' + ppiMonth);
    const value = { status: 'ok', source: SOURCE, month, ppiMonth, items, comextError: c.status === 'fulfilled' ? null : String(c.reason && c.reason.status), ppiError: p.status === 'fulfilled' ? null : String(p.reason && p.reason.status), fetchedAt: new Date().toISOString() };
    cache = { value, exp: Date.now() + TTL_MS };
    return value;
  }

  // 진단: 실제 Comext 요청 결과(품목별 유로/t·톤·기간)와 PPI
  async function probe() {
    const out = { checkedAt: new Date().toISOString(), comext: null, ppi: null };
    try { const c = await comext(fetchImpl, { now: now() }); out.comext = { ok: true, url: c.url.split('&product=')[0] + '&product=…', months: c.months, items: c.items }; }
    catch (e) { out.comext = { ok: false, status: String(e.status), detail: e.detail }; }
    try { out.ppi = Object.assign({ ok: true }, await ppi(fetchImpl)); } catch (e) { out.ppi = { ok: false, status: String(e.status), detail: e.detail }; }
    return out;
  }

  return { latest, probe };
}

module.exports = { createEurostat, flatten, ITEMS, EuError, sinceMonth };
