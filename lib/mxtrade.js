'use strict';
// 멕시코 열(국가 비교 표): 미국 Census 수입 통계로 본 "멕시코산 대미 수출 단가"(달러/t).
// 멕시코산은 트럭·철도 운송이 많아 해상·항공 중량(statehs 방식)을 쓰지 않고, HS10 단위 신고 수량(GEN_QY1_MO, KG/T)을 쓴다.
// 키는 기존 CENSUS_API_KEY를 쓴다. 데이터셋 CC0.
const BASE = process.env.CENSUS_HS_BASE || 'https://api.census.gov/data/timeseries/intltrade/imports/hs';
const MEXICO = '2010';
const SOURCE = { name: 'U.S. Census Bureau, International Trade — U.S. imports from Mexico by HS', note: 'This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.' };
const ITEMS = [
  { id: 'hr', prefixes: ['7208'] }, { id: 'cr', prefixes: ['7209'] }, { id: 'coated', prefixes: ['7210'] },
  { id: 'plate', prefixes: ['720851', '720852'] }, { id: 'wire_rod', prefixes: ['7213'] }, { id: 'rebar', prefixes: ['721420'] },
  { id: 'section', prefixes: ['7216'] }, { id: 'pipe', prefixes: ['7304', '7305', '7306'] }, { id: 'sts', prefixes: ['7219'] },
  { id: 'iron_ore', prefixes: ['2601'] }, { id: 'coking_coal', prefixes: ['270112'] }, { id: 'coke', prefixes: ['2704'] },
  { id: 'scrap', prefixes: ['720441', '720449'] },
  { id: 'al', prefixes: ['7601'] }, { id: 'cu', prefixes: ['7403'] }, { id: 'zn', prefixes: ['7901'] }, { id: 'ni', prefixes: ['7502'] }, { id: 'pb', prefixes: ['7801'] }
];
const TO_TON = { KG: 0.001, T: 1, MT: 1, TNE: 1 };
const LOW_VOLUME_T = 100;
const TTL_MS = 12 * 60 * 60 * 1000;

class MxConfigError extends Error {}
class MxError extends Error { constructor(status, detail) { super('Census HS request failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }
function key() { const k = process.env.CENSUS_API_KEY; if (!k || !k.trim()) throw new MxConfigError('CENSUS_API_KEY is not set'); return k.trim(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function ymBack(d, n) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)); return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0'); }
function prevYm(ym) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

async function month(ym, fetchImpl) {
  const qs = new URLSearchParams({ get: 'I_COMMODITY,GEN_VAL_MO,GEN_QY1_MO,UNIT_QY1', COMM_LVL: 'HS10', CTY_CODE: MEXICO, time: ym, key: key() });
  const res = await fetchImpl(BASE + '?' + qs.toString(), { headers: { Accept: 'application/json' } });
  if (res.status === 204) return [];
  const text = await res.text();
  if (!res.ok) throw new MxError(res.status, text.slice(0, 160).split(key()).join('[redacted]'));
  if (!text.trim()) return [];
  const rows = JSON.parse(text);
  const h = rows[0];
  return rows.slice(1).map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; });
}

// 행(HS10) → 품목별 톤·금액. 단위가 무게(KG/T)가 아닌 HS10은 빼고 개수를 센다.
function aggregate(rows) {
  const out = {};
  ITEMS.forEach(it => {
    const a = { kg: 0, usd: 0, skipped: 0, codes: 0 };
    rows.forEach(r => {
      const c = String(r.I_COMMODITY || '');
      if (!it.prefixes.some(p => c.startsWith(p))) return;
      a.codes++;
      const f = TO_TON[String(r.UNIT_QY1 || '').trim().toUpperCase()];
      if (!f) { a.skipped++; return; }
      const q = num(r.GEN_QY1_MO), v = num(r.GEN_VAL_MO);
      if (!(q > 0)) return;
      a.kg += q * f * 1000; a.usd += v;
    });
    const t = a.kg / 1000;
    out[it.id] = t > 0 ? { status: 'ok', tons: Math.round(t), unitPrice: Math.round(a.usd / t * 100) / 100, lowVolume: t < LOW_VOLUME_T, codes: a.codes, skipped: a.skipped } : { status: 'nodata', codes: a.codes, skipped: a.skipped };
  });
  return out;
}

function createMxTrade(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const now = (opts && opts.now) || (() => new Date());
  const log = (opts && opts.log) || ((m) => console.log(m));
  let cache = null;

  async function find() {
    for (let i = 1; i <= 6; i++) { const ym = ymBack(now(), i); const rows = await month(ym, fetchImpl); if (rows.length) return { ym, rows }; }
    return null;
  }

  async function latest() {
    key();
    if (cache && cache.exp > Date.now()) return cache.value;
    const f = await find();
    if (!f) return { status: 'nodata', source: SOURCE, items: {} };
    const pm = prevYm(f.ym);
    const cur = aggregate(f.rows), prev = aggregate(await month(pm, fetchImpl));
    const items = {};
    Object.keys(cur).forEach(k => { items[k] = Object.assign({}, cur[k], { prev: prev[k].status === 'ok' ? { unitPrice: prev[k].unitPrice, tons: prev[k].tons, lowVolume: prev[k].lowVolume } : null }); });
    log('mx-trade month=' + f.ym + ' ok=' + Object.values(items).filter(x => x.status === 'ok').length + '/' + ITEMS.length);
    const value = { status: 'ok', source: SOURCE, month: f.ym, prevMonth: pm, unit: 'USD/t', items, fetchedAt: new Date().toISOString() };
    cache = { value, exp: Date.now() + TTL_MS };
    return value;
  }

  async function probe() {
    key();
    const f = await find();
    if (!f) return { month: null };
    const units = {};
    f.rows.filter(r => /^(72|73|26|27|74|75|76|78|79)/.test(String(r.I_COMMODITY))).forEach(r => { const u = String(r.UNIT_QY1 || '-'); units[u] = (units[u] || 0) + 1; });
    return { month: f.ym, rows: f.rows.length, unitsInScope: units, items: aggregate(f.rows), sample: f.rows.filter(r => String(r.I_COMMODITY).startsWith('7208')).slice(0, 5), checkedAt: new Date().toISOString() };
  }

  return { latest, probe };
}

module.exports = { createMxTrade, aggregate, MxConfigError, MxError, ITEMS };
