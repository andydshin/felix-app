'use strict';
// KOSIS(국가통계포털) 공유서비스 OpenAPI — 한국은행 생산자물가지수 품목별 지수.
// 인증키는 서버 환경변수 KOSIS_API_KEY에서만 읽는다. 키가 들어간 URL은 로그·응답에 넣지 않는다.
// 표 번호와 품목 코드는 이름으로 찾는다(검색 → 메타 → 데이터). 찾은 이름을 응답에 함께 돌려줘 사람이 확인할 수 있게 한다.

const BASE = process.env.KOSIS_API_BASE || 'https://kosis.kr/openapi';
const SOURCE = { name: '한국은행 생산자물가지수 (KOSIS 국가통계포털 제공)', url: 'https://kosis.kr' };
// 앱 항목 → 품목 이름 후보(앞쪽이 우선)
const KR_PPI = [
  { id: 'kr1', names: ['철근'] },
  { id: 'kr2', names: ['형강', 'H형강'] },
  { id: 'kr3', names: ['열연강판', '열간압연강판', '열연강대', '열간압연강대'] },
  { id: 'kr4', names: ['냉연강판', '냉간압연강판', '냉연강대', '냉간압연강대'] },
  { id: 'kr5', names: ['아연도강판', '용융아연도강판', '도금강판'] },
  { id: 'kr6', names: ['중후판', '후판'] },
  { id: 'kr7', names: ['강관', '용접강관'] },
  { id: 'kr8', names: ['스테인리스강판', '스테인리스냉연강판', '스테인리스 냉연강판', '스테인리스열연강판'] }
];
const TTL_MS = 12 * 60 * 60 * 1000;

class KosisConfigError extends Error {}
class KosisUpstreamError extends Error {
  constructor(status, detail) { super('KOSIS request failed (' + status + ')'); this.status = status; this.detail = detail || ''; }
}

function apiKey() {
  const k = process.env.KOSIS_API_KEY;
  if (!k || !k.trim()) throw new KosisConfigError('KOSIS_API_KEY is not set on the server');
  return k.trim();
}
function redactStr(s) {
  const k = process.env.KOSIS_API_KEY && process.env.KOSIS_API_KEY.trim();
  let out = String(s);
  if (k) [k, encodeURIComponent(k)].forEach(x => { out = out.split(x).join('[redacted]'); });
  return out;
}
function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').trim(); }

// KOSIS는 JSON 키에 따옴표가 없는 응답을 줄 때가 있어 jsonVD=Y로 표준 JSON을 요청한다.
async function call(path, params, fetchImpl) {
  const qs = new URLSearchParams(Object.assign({}, params, { apiKey: apiKey(), format: 'json', jsonVD: 'Y' }));
  const res = await fetchImpl(BASE + path + '?' + qs.toString(), { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new KosisUpstreamError(res.status, redactStr(text.slice(0, 200)));
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new KosisUpstreamError('invalid-json', redactStr(text.slice(0, 200))); }
  if (body && !Array.isArray(body) && (body.err || body.errMsg)) {
    // err 30: 데이터 없음 → 빈 배열로 다룬다
    if (String(body.err) === '30') return [];
    throw new KosisUpstreamError('api-' + body.err, redactStr(body.errMsg || ''));
  }
  return Array.isArray(body) ? body : [];
}

const search = (word, f) => call('/statisticsSearch.do', { method: 'getList', searchNm: word, startCount: '1', resultCount: '50' }, f);
const meta = (orgId, tblId, f) => call('/statisticsData.do', { method: 'getMeta', type: 'ITM', orgId, tblId }, f);
const data = (p, f) => call('/Param/statisticsParameterData.do', Object.assign({ method: 'getList', prdSe: 'M' }, p), f);

// 생산자물가지수 품목별(기본분류) 표 고르기: 이름에 '생산자물가지수'가 있고 '기본분류'(또는 '품목')가 있는 한국은행 표
function pickTable(rows) {
  const t = rows.map(r => ({ orgId: String(r.ORG_ID || ''), tblId: String(r.TBL_ID || ''), name: String(r.TBL_NM || ''), stat: String(r.STAT_NM || r.ORG_NM || '') }))
    .filter(r => r.orgId && r.tblId && /생산자물가지수/.test(r.name));
  const score = r => (/기본분류/.test(r.name) ? 4 : 0) + (/품목/.test(r.name) ? 2 : 0) + (r.orgId === '301' ? 1 : 0) - (/특수분류|가공단계|국내공급|총산출|수출|수입/.test(r.name) ? 5 : 0);
  return { candidates: t.slice(0, 15), best: t.slice().sort((a, b) => score(b) - score(a))[0] || null };
}

// 메타(ITM) → 분류(OBJ) 항목 중 품목 이름 찾기. 정확히 같은 이름 우선, 없으면 포함.
function matchItems(metaRows) {
  // 분류 차원(OBJ_ID)은 나온 순서대로 objL1, objL2 … 에 대응한다. 'ITEM'은 항목(지수 등)이라 제외.
  const order = [];
  metaRows.forEach(r => { const o = String(r.OBJ_ID || ''); if (o && o !== 'ITEM' && !order.includes(o)) order.push(o); });
  const objs = metaRows.filter(r => r.OBJ_ID && String(r.OBJ_ID) !== 'ITEM' && r.ITM_ID).map(r => ({ objId: String(r.OBJ_ID), objName: String(r.OBJ_NM || ''), level: order.indexOf(String(r.OBJ_ID)) + 1, code: String(r.ITM_ID), name: String(r.ITM_NM || ''), up: String(r.UP_ITM_ID || '') }));
  const items = metaRows.filter(r => !r.OBJ_ID || String(r.OBJ_ID) === 'ITEM').map(r => ({ code: String(r.ITM_ID), name: String(r.ITM_NM || '') }));
  const out = {};
  KR_PPI.forEach(p => {
    let hit = null;
    for (const n of p.names) { hit = objs.find(o => norm(o.name) === norm(n)); if (hit) break; }
    if (!hit) for (const n of p.names) { const c = objs.filter(o => norm(o.name).includes(norm(n))).sort((a, b) => a.name.length - b.name.length); if (c.length) { hit = c[0]; break; } }
    out[p.id] = hit || null;
  });
  return { matches: out, objCount: objs.length, levels: order.length, itemList: items.slice(0, 5) };
}

function prevMonthCode(p) { const y = Number(p.slice(0, 4)), m = Number(p.slice(4, 6)); const d = new Date(Date.UTC(y, m - 2, 1)); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0'); }

function createKosis(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const log = (opts && opts.log) || ((m) => console.log(m));
  let cacheVal = null;

  async function locate() {
    const found = pickTable(await search('생산자물가지수', fetchImpl));
    if (!found.best) return { table: null, candidates: found.candidates };
    const m = matchItems(await meta(found.best.orgId, found.best.tblId, fetchImpl));
    return Object.assign({ table: found.best, candidates: found.candidates }, m);
  }

  // 진단: 고른 표, 후보 표, 찾은 품목 이름, 샘플 값
  async function probe() {
    apiKey();
    const loc = await locate();
    let sample = null;
    const first = loc.matches && Object.values(loc.matches).find(Boolean);
    if (loc.table && first) {
      const sp = { orgId: loc.table.orgId, tblId: loc.table.tblId, itmId: 'ALL', newEstPrdCnt: '2' };
      sp['objL' + (first.level || 1)] = first.code;
      try { sample = (await data(sp, fetchImpl)).slice(0, 6); }
      catch (e) { sample = { error: String(e.status), message: e.detail }; }
    }
    return JSON.parse(redactStr(JSON.stringify({ table: loc.table, candidates: loc.candidates, matches: loc.matches, objCount: loc.objCount, levels: loc.levels, itemList: loc.itemList, sample, checkedAt: new Date().toISOString() })));
  }

  async function latest() {
    apiKey();
    if (cacheVal && cacheVal.exp > Date.now()) return cacheVal.value;
    const loc = await locate();
    if (!loc.table) return { status: 'nodata', source: SOURCE, items: [] };
    const items = [];
    for (const p of KR_PPI) {
      const hit = loc.matches[p.id];
      if (!hit) { items.push({ id: p.id, status: 'nodata', reason: 'item_not_found' }); continue; }
      const params = { orgId: loc.table.orgId, tblId: loc.table.tblId, itmId: 'ALL', newEstPrdCnt: '3' };
      params['objL' + (hit.level || 1)] = hit.code;
      for (let l = 1; l < (hit.level || 1); l++) params['objL' + l] = 'ALL';
      const rows = (await data(params, fetchImpl)).filter(r => r.PRD_DE && r.DT != null && r.DT !== '' && r.DT !== '-');
      rows.sort((a, b) => String(a.PRD_DE).localeCompare(String(b.PRD_DE)));
      const last = rows[rows.length - 1];
      if (!last) { items.push({ id: p.id, status: 'nodata', matchedName: hit.name }); continue; }
      const prev = rows.find(r => String(r.PRD_DE) === prevMonthCode(String(last.PRD_DE)));
      const v = Number(last.DT), pv = prev ? Number(prev.DT) : null;
      items.push({ id: p.id, status: 'ok', matchedName: hit.name, code: hit.code, period: String(last.PRD_DE).slice(0, 4) + '-' + String(last.PRD_DE).slice(4, 6),
        value: v, prev: pv, change: pv != null ? Math.round((v - pv) * 100) / 100 : null, changePct: pv ? Math.round((v - pv) / pv * 10000) / 100 : null, unit: last.UNIT_NM || '' });
    }
    const period = items.filter(i => i.status === 'ok').map(i => i.period).sort().pop() || null;
    log('kosis ppi table=' + loc.table.tblId + ' period=' + period + ' ok=' + items.filter(i => i.status === 'ok').length + '/' + items.length);
    const value = JSON.parse(redactStr(JSON.stringify({ status: 'ok', source: SOURCE, table: loc.table, period, items, fetchedAt: new Date().toISOString() })));
    cacheVal = { value, exp: Date.now() + TTL_MS };
    return value;
  }

  return { probe, latest };
}

module.exports = { createKosis, pickTable, matchItems, KosisConfigError, KosisUpstreamError, KR_PPI };
