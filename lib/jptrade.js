'use strict';
// 일본 재무성 무역통계(e-Stat 品別国別表)로 품목별 수출·수입 단가(엔/t)를 계산한다.
// 단가(엔/t) = 금액(千円) × 1,000 ÷ 수량(t). 수량 단위가 t·kg가 아닌 세부 품목은 계산에서 뺀다.
// 앱 ID는 ESTAT_APP_ID 환경변수에서만 읽고(estat.js), 응답·로그에 넣지 않는다.
const { call, appId, arr, txt, redact, CREDIT, TRADE_STATS_CODE, summarizeTable } = require('./estat');

// flow: export(수출) | import(수입). prefixes: 9자리 통계품목번호의 앞자리(HS).
const JP_ITEMS = [
  { id: 'iron_ore', group: 'raw', flow: 'import', prefixes: ['2601'] },
  { id: 'coal', group: 'raw', flow: 'import', prefixes: ['270112'] },
  { id: 'scrap', group: 'raw', flow: 'export', prefixes: ['720441', '720449'] },
  { id: 'hr', group: 'steel', flow: 'export', prefixes: ['7208'] },
  { id: 'cr', group: 'steel', flow: 'export', prefixes: ['7209'] },
  { id: 'coated', group: 'steel', flow: 'export', prefixes: ['7210'] },
  { id: 'plate', group: 'steel', flow: 'export', prefixes: ['720851'] },
  { id: 'wire_rod', group: 'steel', flow: 'export', prefixes: ['7213'] },
  { id: 'rebar', group: 'steel', flow: 'export', prefixes: ['721420'] },
  { id: 'pipe', group: 'steel', flow: 'export', prefixes: ['7304', '7305', '7306'] },
  { id: 'al', group: 'nonferrous', flow: 'import', prefixes: ['7601'] },
  { id: 'cu', group: 'nonferrous', flow: 'export', prefixes: ['7403'] },
  { id: 'ni', group: 'nonferrous', flow: 'import', prefixes: ['750210'] },
  { id: 'zn', group: 'nonferrous', flow: 'import', prefixes: ['7901'] }
];
const STAT_NAME = { export: '貿易統計_全国分 品別国別表 輸出', import: '貿易統計_全国分 品別国別表 輸入' };
const LOW_VOLUME_T = 100;
const TABLE_TTL_MS = 6 * 60 * 60 * 1000;
const DATA_TTL_MS = 12 * 60 * 60 * 1000;
const CODES_PER_CALL = 40;
const CONCURRENCY = 3; // e-Stat 약관: 짧은 시간 대량 호출 금지
const WEIGHT = { MT: 1, KG: 0.001 };
const COUNTRY_KO = {
  '大韓民国': '한국', '中華人民共和国': '중국', '台湾': '대만', '香港': '홍콩', 'ベトナム': '베트남', 'タイ': '태국',
  'シンガポール': '싱가포르', 'マレーシア': '말레이시아', 'フィリピン': '필리핀', 'インドネシア': '인도네시아', 'インド': '인도',
  'アメリカ合衆国': '미국', 'カナダ': '캐나다', 'メキシコ': '멕시코', 'オーストラリア': '호주', 'ニュージーランド': '뉴질랜드',
  'ブラジル': '브라질', 'チリ': '칠레', 'ペルー': '페루', '南アフリカ共和国': '남아공', 'ロシア': '러시아', 'ドイツ': '독일',
  'アラブ首長国連邦': 'UAE', 'サウジアラビア': '사우디', 'カタール': '카타르', 'トルコ': '튀르키예', 'バングラデシュ': '방글라데시',
  'パキスタン': '파키스탄', 'ミャンマー': '미얀마', 'カンボジア': '캄보디아', 'イタリア': '이탈리아', 'フランス': '프랑스',
  'スペイン': '스페인', '英国': '영국', 'オランダ': '네덜란드', 'ベルギー': '벨기에', 'ノルウェー': '노르웨이', 'スウェーデン': '스웨덴'
};

function norm(s) { return String(s == null ? '' : s).normalize('NFKC').trim(); }
function num(v) { const n = Number(norm(v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; }
function koCountry(name) { const jp = norm(name).replace(/^\d+_/, ''); return COUNTRY_KO[jp] || jp; }

// 표 이름에서 들어 있는 마지막 월과 속보 여부를 읽는다. 예: "輸入(1-7月：確報、8月：輸入9桁速報) 2026年" → 8, 속보
function monthsInTitle(title) {
  const t = norm(title);
  let max = 0;
  for (const m of t.matchAll(/(\d{1,2})-(\d{1,2})月/g)) max = Math.max(max, Number(m[2]));
  for (const m of t.matchAll(/[、,(（](\d{1,2})月[:：]/g)) max = Math.max(max, Number(m[1]));
  const prelim = max > 0 && new RegExp('[、,(（]' + max + '月[:：][^)）]*速報').test(t);
  const year = (t.match(/(\d{4})年\s*$/) || t.match(/(\d{4})年/g) || []).toString().match(/\d{4}/g);
  return { month: max, preliminary: prelim, year: year ? Number(year[year.length - 1]) : null };
}

function rowsOf(root) {
  const sd = root.STATISTICAL_DATA || {};
  return arr(sd.DATA_INF && sd.DATA_INF.VALUE);
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  async function worker() { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

// 한 품목의 레코드(9자리 코드 × 국가 × 항목)를 월별 톤·금액으로 합산한다.
function aggregate(rows, cat02, months, areaNames) {
  const unit = {}; // code → { q1: 'MT'|..., q2: ... }
  rows.forEach(r => {
    if (r['@cat02'] === cat02.unit1) (unit[r['@cat01']] = unit[r['@cat01']] || {}).q1 = norm(r.$);
    if (r['@cat02'] === cat02.unit2) (unit[r['@cat01']] = unit[r['@cat01']] || {}).q2 = norm(r.$);
  });
  const pickQty = code => {
    const u = unit[code] || {};
    if (WEIGHT[u.q2]) return { key: 'q2', f: WEIGHT[u.q2] };
    if (WEIGHT[u.q1]) return { key: 'q1', f: WEIGHT[u.q1] };
    return null;
  };
  const skipped = new Set();
  const out = {};
  months.forEach(m => { out[m] = { tons: 0, kyen: 0, byArea: {} }; });
  rows.forEach(r => {
    const code = r['@cat01'];
    for (const m of months) {
      const c = cat02.month[m];
      if (!c) continue;
      const q = pickQty(code);
      if (!q) { skipped.add(code); continue; }
      const acc = out[m];
      const area = r['@area'];
      const b = acc.byArea[area] = acc.byArea[area] || { tons: 0, kyen: 0 };
      if (r['@cat02'] === c[q.key]) { const t = num(r.$) * q.f; acc.tons += t; b.tons += t; }
      if (r['@cat02'] === c.value) { const v = num(r.$); acc.kyen += v; b.kyen += v; }
    }
  });
  const result = {};
  months.forEach(m => {
    const a = out[m];
    if (!(a.tons > 0)) { result[m] = { status: 'nodata' }; return; }
    const top = Object.keys(a.byArea).map(k => ({ area: k, tons: a.byArea[k].tons }))
      .filter(x => x.tons > 0).sort((x, y) => y.tons - x.tons).slice(0, 3)
      .map(x => ({ name: koCountry(areaNames[x.area] || x.area), share: Math.round(x.tons / a.tons * 1000) / 10 }));
    result[m] = {
      status: 'ok',
      unitPriceJpy: Math.round(a.kyen * 1000 / a.tons),
      tons: Math.round(a.tons),
      valueMillionJpy: Math.round(a.kyen / 1000),
      lowVolume: a.tons < LOW_VOLUME_T,
      topPartners: top
    };
  });
  return { byMonth: result, skippedCodes: skipped.size };
}

function createJpTrade(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
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

  // 최신 연도의 품목·국가별 수출표/수입표와 그 구조(품목 코드, 월별 항목 코드, 국가 이름)
  function tables() {
    return cached('tables', TABLE_TTL_MS, async () => {
      const list = await call('getStatsList', { statsCode: TRADE_STATS_CODE, searchWord: '品別国別表', limit: '200' }, fetchImpl);
      const all = arr(list.root.DATALIST_INF && list.root.DATALIST_INF.TABLE_INF).map(summarizeTable);
      const out = {};
      for (const flow of ['export', 'import']) {
        const t = all.filter(x => norm(x.statName) === STAT_NAME[flow])
          .sort((a, b) => String(b.surveyDate).localeCompare(String(a.surveyDate)) || String(b.updated).localeCompare(String(a.updated)))[0];
        if (!t) { out[flow] = null; continue; }
        const meta = await call('getMetaInfo', { statsDataId: t.id }, fetchImpl);
        const objs = arr(meta.root.METADATA_INF && meta.root.METADATA_INF.CLASS_INF && meta.root.METADATA_INF.CLASS_INF.CLASS_OBJ);
        const byId = {};
        objs.forEach(o => { byId[o['@id']] = arr(o.CLASS); });
        const cat02 = { month: {} };
        (byId.cat02 || []).forEach(c => {
          const name = norm(c['@name']);
          if (name === '単位1') cat02.unit1 = c['@code'];
          else if (name === '単位2') cat02.unit2 = c['@code'];
          const m = name.match(/^(\d{1,2})月_(数量1|数量2|金額)$/);
          if (m) {
            const slot = cat02.month[Number(m[1])] = cat02.month[Number(m[1])] || {};
            slot[m[2] === '数量1' ? 'q1' : (m[2] === '数量2' ? 'q2' : 'value')] = c['@code'];
          }
        });
        const areaNames = {};
        (byId.area || []).forEach(c => { areaNames[c['@code']] = c['@name']; });
        const info = monthsInTitle(t.tableName || t.title);
        out[flow] = { id: t.id, title: t.title, updated: t.updated, year: info.year, lastMonth: info.month, preliminary: info.preliminary,
          codes: (byId.cat01 || []).map(c => String(c['@code'])), cat02, areaNames, time: (byId.time || [])[0] && byId.time[0]['@code'] };
      }
      return out;
    });
  }

  async function fetchItem(t, item, months) {
    const codes = t.codes.filter(c => item.prefixes.some(p => c.startsWith(p)));
    if (!codes.length) return { byMonth: Object.fromEntries(months.map(m => [m, { status: 'nodata' }])), codeCount: 0, skippedCodes: 0 };
    const want = [t.cat02.unit1, t.cat02.unit2];
    months.forEach(m => { const s = t.cat02.month[m] || {}; want.push(s.q1, s.q2, s.value); });
    const cdCat02 = want.filter(Boolean).join(',');
    const rows = [];
    for (let i = 0; i < codes.length; i += CODES_PER_CALL) {
      const params = { statsDataId: t.id, cdCat01: codes.slice(i, i + CODES_PER_CALL).join(','), cdCat02, metaGetFlg: 'N', cntGetFlg: 'N', limit: '100000' };
      if (t.time) params.cdTime = t.time;
      for (let page = 0; page < 5; page++) { // 10만 건을 넘으면 NEXT_KEY로 이어 받는다
        const r = await call('getStatsData', params, fetchImpl);
        rows.push(...rowsOf(r.root));
        const next = r.root.STATISTICAL_DATA && r.root.STATISTICAL_DATA.RESULT_INF && txt(r.root.STATISTICAL_DATA.RESULT_INF.NEXT_KEY);
        if (!next) break;
        params.startPosition = next;
      }
    }
    const agg = aggregate(rows, t.cat02, months, t.areaNames);
    return Object.assign({ codeCount: codes.length }, agg);
  }

  async function latest() {
    appId();
    const tb = await tables();
    return cached('data:' + (tb.export && tb.export.id) + ':' + (tb.export && tb.export.lastMonth) + ':' + (tb.import && tb.import.id) + ':' + (tb.import && tb.import.lastMonth), DATA_TTL_MS, async () => {
      const plan = JP_ITEMS.map(it => ({ it, t: tb[it.flow] }));
      const tasks = plan.map(({ it, t }) => async () => {
        if (!t || !t.lastMonth) return { status: 'nodata' };
        const m = t.lastMonth;
        const months = m > 1 ? [m, m - 1] : [m];
        const r = await fetchItem(t, it, months);
        const cur = r.byMonth[m] || { status: 'nodata' };
        const prev = m > 1 ? (r.byMonth[m - 1] || { status: 'nodata' }) : { status: 'nodata', reason: 'prev_year_table' };
        return Object.assign({}, cur, { month: t.year + '-' + String(m).padStart(2, '0'), preliminary: !!t.preliminary,
          codeCount: r.codeCount, skippedCodes: r.skippedCodes,
          prev: { status: prev.status, unitPriceJpy: prev.unitPriceJpy, tons: prev.tons, lowVolume: prev.lowVolume } });
      });
      const res = await pool(tasks, CONCURRENCY);
      const items = plan.map(({ it }, i) => Object.assign({ id: it.id, group: it.group, flow: it.flow, prefixes: it.prefixes }, res[i]));
      const src = f => tb[f] && { id: tb[f].id, title: tb[f].title, updated: tb[f].updated, month: tb[f].year + '-' + String(tb[f].lastMonth).padStart(2, '0'), preliminary: tb[f].preliminary };
      log('estat jp-trade export=' + (tb.export && tb.export.id) + ' import=' + (tb.import && tb.import.id) + ' ok=' + items.filter(x => x.status === 'ok').length + '/' + items.length);
      return redact({
        source: { name: '財務省 貿易統計 (e-Stat 品別国別表)', export: src('export'), import: src('import') },
        credit: CREDIT, unit: 'JPY/t', items, fetchedAt: new Date().toISOString()
      });
    });
  }

  return { latest, tables };
}

module.exports = { createJpTrade, monthsInTitle, aggregate, JP_ITEMS, LOW_VOLUME_T };
