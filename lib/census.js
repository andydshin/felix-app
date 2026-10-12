'use strict';
// U.S. Census Bureau 주별 수입 통계(statehs)로 "해상·항공 수입 단가"를 계산한다.
// API 키는 서버 환경변수 CENSUS_API_KEY에서만 읽는다. 키가 들어간 URL은 로그·응답·오류 메시지에 절대 넣지 않는다.

const BASE = process.env.CENSUS_API_BASE || 'https://api.census.gov/data/timeseries/intltrade/imports/statehs';
const SOURCE = {
  name: 'U.S. Census Bureau, International Trade (State Imports by HS)',
  url: 'https://api.census.gov/data/timeseries/intltrade/imports/statehs',
  notice: 'This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.'
};

const STATES = ['TX', 'CA', 'LA', 'IL', 'OH', 'MI', 'PA', 'AL'];

// 앱의 품목 구성과 같은 순서. codes가 여러 개면 분자·분모를 각각 합산한다.
const ITEMS = [
  { id: 'iron_ore', group: 'raw', codes: ['2601'] },
  { id: 'scrap', group: 'raw', codes: ['720441', '720449'] },
  { id: 'coal', group: 'raw', codes: ['270112'] },
  { id: 'hr', group: 'steel', codes: ['7208'] },
  { id: 'cr', group: 'steel', codes: ['7209'] },
  { id: 'coated', group: 'steel', codes: ['7210'] },
  { id: 'plate', group: 'steel', codes: ['720851'] },
  { id: 'wire_rod', group: 'steel', codes: ['7213'] },
  { id: 'rebar', group: 'steel', codes: ['721420'] },
  { id: 'pipe', group: 'steel', codes: ['7304', '7305', '7306'] },
  { id: 'al', group: 'nonferrous', codes: ['7601'] },
  { id: 'cu', group: 'nonferrous', codes: ['7403'] },
  { id: 'ni', group: 'nonferrous', codes: ['750210'] },
  { id: 'zn', group: 'nonferrous', codes: ['7901'] }
];

const FIELDS = ['I_COMMODITY_SDESC', 'GEN_VAL_MO', 'VES_VAL_MO', 'AIR_VAL_MO', 'VES_WGT_MO', 'AIR_WGT_MO'];
// 운송 중량이 이보다 적으면 몇 건의 특수재가 단가를 좌우하므로 '물량 적음'으로 표시한다.
const LOW_VOLUME_T = 100;
const DATA_TTL_MS = 12 * 60 * 60 * 1000;
const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
const MONTHS_BACK = 8;
const CONCURRENCY = 6;

class ConfigError extends Error {}
class UpstreamError extends Error {
  constructor(status) { super('Census API request failed (status ' + status + ')'); this.status = status; }
}

// 단가(달러/t) = (해상 금액 + 항공 금액) / (해상 운송 중량 + 항공 운송 중량, kg) * 1000
// 분자와 분모의 운송 범위를 맞춘다. GEN_VAL_MO(전체 수입액)는 쓰지 않는다.
function unitPrice(rec) {
  if (!rec) return { status: 'nodata' };
  const val = num(rec.VES_VAL_MO) + num(rec.AIR_VAL_MO);
  const wgt = num(rec.VES_WGT_MO) + num(rec.AIR_WGT_MO);
  if (!(wgt > 0)) return { status: 'nodata' };
  return { status: 'ok', unitPrice: round2(val / wgt * 1000), weightT: round2(wgt / 1000), lowVolume: wgt / 1000 < LOW_VOLUME_T, vesVal: num(rec.VES_VAL_MO), airVal: num(rec.AIR_VAL_MO), vesWgtKg: num(rec.VES_WGT_MO), airWgtKg: num(rec.AIR_WGT_MO) };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(n) { return Math.round(n * 100) / 100; }
function sumRecords(recs) {
  const got = recs.filter(Boolean);
  if (!got.length) return null;
  const out = { VES_VAL_MO: 0, AIR_VAL_MO: 0, VES_WGT_MO: 0, AIR_WGT_MO: 0 };
  got.forEach(r => { Object.keys(out).forEach(k => { out[k] += num(r[k]); }); });
  return out;
}

function apiKey() {
  const k = process.env.CENSUS_API_KEY;
  if (!k || !k.trim()) throw new ConfigError('CENSUS_API_KEY is not set on the server');
  return k.trim();
}

// Census 응답: 첫 행이 헤더인 2차원 배열. 데이터가 없으면 HTTP 204 또는 빈 본문.
async function query(params, fetchImpl) {
  const qs = new URLSearchParams(Object.assign({}, params, { key: apiKey() }));
  const res = await fetchImpl(BASE + '?' + qs.toString(), { headers: { Accept: 'application/json' } });
  if (res.status === 204) return [];
  if (!res.ok) throw new UpstreamError(res.status);
  const text = await res.text();
  if (!text || !text.trim()) return [];
  let rows;
  try { rows = JSON.parse(text); } catch (e) { throw new UpstreamError('invalid-json'); }
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const head = rows[0];
  return rows.slice(1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i]; }); return o; });
}

function monthsBack(fromDate, n) {
  const out = [];
  const d = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
  for (let i = 1; i <= n; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.getUTCFullYear() + '-' + String(m.getUTCMonth() + 1).padStart(2, '0'));
  }
  return out;
}
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  async function worker() { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

function createService(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const now = (opts && opts.now) || (() => new Date());
  const log = (opts && opts.log) || ((m) => console.log(m));
  const cache = new Map();
  const inflight = new Map();

  function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return Promise.resolve(Object.assign({}, hit.value, { cache: 'hit' }));
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().then(v => { cache.set(key, { value: v, exp: Date.now() + ttl }); inflight.delete(key); return Object.assign({}, v, { cache: 'miss' }); },
      e => { inflight.delete(key); throw e; });
    inflight.set(key, p);
    return p;
  }

  // 조회 가능한 최신 월: 지난달부터 거꾸로 확인해 데이터가 있는 첫 달. 없는 달의 값은 만들지 않는다.
  function latestMonth() {
    return cached('latest', LATEST_TTL_MS, async () => {
      for (const ym of monthsBack(now(), MONTHS_BACK)) {
        const rows = await query({ get: 'GEN_VAL_MO', STATE: 'TX', I_COMMODITY: '72', time: ym }, fetchImpl);
        if (rows.length) return { month: ym };
      }
      return { month: null };
    }).then(v => v.month);
  }

  async function fetchCode(state, code, ym) {
    const rows = await query({ get: FIELDS.join(','), STATE: state, I_COMMODITY: code, time: ym }, fetchImpl);
    return rows.find(r => String(r.I_COMMODITY) === code && (r.CTY_CODE === undefined || r.CTY_CODE === '-')) || rows[0] || null;
  }

  async function itemFor(state, item, ym) {
    const recs = await Promise.all(item.codes.map(c => fetchCode(state, c, ym)));
    return unitPrice(sumRecords(recs));
  }

  async function stateImports(state) {
    if (!STATES.includes(state)) { const e = new Error('unsupported state'); e.code = 'BAD_STATE'; throw e; }
    apiKey();
    const month = await latestMonth();
    if (!month) return { state, month: null, prevMonth: null, source: SOURCE, items: ITEMS.map(it => ({ id: it.id, codes: it.codes, status: 'nodata', prev: { status: 'nodata' } })) };
    const pm = prevMonth(month);
    return cached('state:' + state + ':' + month, DATA_TTL_MS, async () => {
      const tasks = [];
      ITEMS.forEach(it => { tasks.push(() => itemFor(state, it, month)); tasks.push(() => itemFor(state, it, pm)); });
      const res = await pool(tasks, CONCURRENCY);
      const items = ITEMS.map((it, i) => Object.assign({ id: it.id, group: it.group, codes: it.codes }, res[i * 2], { prev: { status: res[i * 2 + 1].status, unitPrice: res[i * 2 + 1].unitPrice, weightT: res[i * 2 + 1].weightT, lowVolume: res[i * 2 + 1].lowVolume } }));
      log('census state=' + state + ' month=' + month + ' ok=' + items.filter(x => x.status === 'ok').length + '/' + items.length);
      return { state, month, prevMonth: pm, source: SOURCE, items, fetchedAt: new Date().toISOString() };
    });
  }

  return { stateImports, latestMonth };
}

module.exports = { LOW_VOLUME_T, createService, unitPrice, sumRecords, monthsBack, prevMonth, STATES, ITEMS, SOURCE, ConfigError, UpstreamError };
