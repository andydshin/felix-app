'use strict';
// 실제 e-Stat 응답 구조(2026-10-12 진단 결과)를 본뜬 가짜 fetch로 일본 단가 계산을 검증한다.
const test = require('node:test');
const assert = require('node:assert');

const FAKE_ID = 'ESTAT_FAKE_APPID_JP_DO_NOT_LEAK';
process.env.ESTAT_APP_ID = FAKE_ID;
const { createJpTrade, monthsInTitle } = require('../lib/jptrade');

test('표 이름에서 마지막 월·속보 여부·연도를 읽는다', () => {
  assert.deepStrictEqual(monthsInTitle('品別国別表 輸出(1-8月：確報) 2026年'), { month: 8, preliminary: false, year: 2026 });
  assert.deepStrictEqual(monthsInTitle('品別国別表 輸入(1-7月：確報、8月：輸入9桁速報) 2026年'), { month: 8, preliminary: true, year: 2026 });
});

// cat02: 100 単位1, 110 単位2, 120~140 합계, 이후 월별 (数量1, 数量2, 金額) — 실제 표와 같은 배치
function cat02Classes() {
  const c = [{ '@code': '100', '@name': '単位1' }, { '@code': '110', '@name': '単位2' },
    { '@code': '120', '@name': '合計_数量1' }, { '@code': '130', '@name': '合計_数量2' }, { '@code': '140', '@name': '合計_金額', '@unit': '千円' }];
  for (let m = 1; m <= 12; m++) {
    const b = 150 + (m - 1) * 30;
    c.push({ '@code': String(b), '@name': m + '月_数量1' }, { '@code': String(b + 10), '@name': m + '月_数量2' }, { '@code': String(b + 20), '@name': m + '月_金額', '@unit': '千円' });
  }
  return c;
}
const M = m => ({ q1: String(150 + (m - 1) * 30), q2: String(160 + (m - 1) * 30), v: String(170 + (m - 1) * 30) });

// [flow, code, area, unit2, {month: [qty2, 千円]}]
const DATA = [
  ['import', '260111000', '50601', 'ＭＴ', { 8: [4000000, 60000000], 7: [3000000, 42000000] }],
  ['import', '260111000', '50410', 'ＭＴ', { 8: [1000000, 15000000] }],
  ['import', '260112000', '50601', 'ＭＴ', { 8: [0, 0] }],
  ['export', '720827000', '50103', 'ＭＴ', { 8: [50000, 5000000], 7: [40000, 4200000] }],
  ['export', '720827000', '50110', 'ＭＴ', { 8: [30000, 2700000] }],
  ['export', '720838000', '50105', 'ＫＧ', { 8: [20000000, 2300000] }], // kg 단위 세부 품목
  ['export', '720890000', '50105', 'ＮＯ', { 8: [5, 999999] }],       // 개수 단위: 단가에서 제외
  ['export', '720851000', '50304', 'ＭＴ', { 8: [60, 9000] }]          // 후판: 물량 적음
];

function fakeFetch(calls) {
  const resp = o => ({ status: 200, ok: true, text: async () => JSON.stringify(o) });
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const method = u.pathname.split('/').pop();
    const p = Object.fromEntries(u.searchParams);
    if (p.appId !== FAKE_ID) return resp({ X: { RESULT: { STATUS: 100, ERROR_MSG: 'auth' } } });
    if (method === 'getStatsList') return resp({ GET_STATS_LIST: { RESULT: { STATUS: 0 }, DATALIST_INF: { TABLE_INF: [
      { '@id': 'EXP2026', TITLE: '確報 品別国別表 輸出(1-8月：確報) 2026年', TITLE_SPEC: { TABLE_NAME: '品別国別表 輸出(1-8月：確報) 2026年' }, STATISTICS_NAME: '貿易統計_全国分 品別国別表 輸出', SURVEY_DATE: '202601-202612', UPDATED_DATE: '2026-09-29' },
      { '@id': 'IMP2026', TITLE: '確速 品別国別表 輸入(1-7月：確報、8月：輸入9桁速報) 2026年', TITLE_SPEC: { TABLE_NAME: '品別国別表 輸入(1-7月：確報、8月：輸入9桁速報) 2026年' }, STATISTICS_NAME: '貿易統計_全国分 品別国別表 輸入', SURVEY_DATE: '202601-202612', UPDATED_DATE: '2026-09-29' },
      { '@id': 'GAIKYO', TITLE: '確報 概況品別国別表 輸出(1-8月：確報) 2026年', STATISTICS_NAME: '貿易統計_全国分 概況品別国別表 輸出', SURVEY_DATE: '202601-202612' },
      { '@id': 'EXP2025', TITLE: '確報 品別国別表 輸出 2021年～2025年', STATISTICS_NAME: '貿易統計_全国分 品別国別表 輸出', SURVEY_DATE: '202501-202512' }
    ] } } });
    if (method === 'getMetaInfo') {
      const flow = p.statsDataId === 'EXP2026' ? 'export' : 'import';
      const codes = [...new Set(DATA.filter(d => d[0] === flow).map(d => d[1]))].concat(['010121000']);
      return resp({ GET_META_INFO: { RESULT: { STATUS: 0 }, METADATA_INF: { CLASS_INF: { CLASS_OBJ: [
        { '@id': 'cat01', '@name': '統計品目表', CLASS: codes.map(c => ({ '@code': c, '@name': c })) },
        { '@id': 'cat02', '@name': '統計品目表の数量・金額', CLASS: cat02Classes() },
        { '@id': 'area', '@name': '国', CLASS: [['50103', '103_大韓民国'], ['50105', '105_中華人民共和国'], ['50110', '110_ベトナム'], ['50304', '304_アメリカ合衆国'], ['50410', '410_ブラジル'], ['50601', '601_オーストラリア']].map(x => ({ '@code': x[0], '@name': x[1] })) },
        { '@id': 'time', '@name': '時間軸(年次)', CLASS: { '@code': '2026000000', '@name': '2026年' } }
      ] } } } });
    }
    if (method === 'getStatsData') {
      const flow = p.statsDataId === 'EXP2026' ? 'export' : 'import';
      const codes = p.cdCat01.split(','), want = new Set(p.cdCat02.split(','));
      assert.ok(codes.length <= 40);
      const values = [];
      DATA.filter(d => d[0] === flow && codes.includes(d[1])).forEach(([, code, area, u2, months]) => {
        const add = (c, v) => { if (want.has(c)) values.push({ '@cat01': code, '@cat02': c, '@area': area, '@time': '2026000000', $: String(v) }); };
        add('100', ''); add('110', u2);
        [7, 8].forEach(m => { const x = months[m] || [0, 0]; add(M(m).q1, 0); add(M(m).q2, x[0]); add(M(m).v, x[1]); });
      });
      return resp({ GET_STATS_DATA: { RESULT: { STATUS: values.length ? 0 : 1 }, STATISTICAL_DATA: { RESULT_INF: { TOTAL_NUMBER: values.length }, DATA_INF: { VALUE: values } } } });
    }
    return { status: 404, ok: false, text: async () => '' };
  };
}

test('일본 단가: 최신 표 선택, 톤 환산, 단위 제외, 물량 적음, 주요 상대국, 앱 ID 비노출', async () => {
  const calls = [], logs = [];
  const svc = createJpTrade({ fetch: fakeFetch(calls), log: m => logs.push(m) });
  const r = await svc.latest();
  assert.strictEqual(r.source.export.id, 'EXP2026');
  assert.strictEqual(r.source.import.id, 'IMP2026');
  assert.strictEqual(r.source.import.preliminary, true);
  const ore = r.items.find(i => i.id === 'iron_ore');
  assert.strictEqual(ore.month, '2026-08');
  assert.strictEqual(ore.flow, 'import');
  assert.strictEqual(ore.tons, 5000000);
  assert.strictEqual(ore.unitPriceJpy, 15000);          // (60,000,000+15,000,000)천엔 / 5,000,000t
  assert.strictEqual(ore.prev.unitPriceJpy, 14000);
  assert.deepStrictEqual(ore.topPartners[0], { name: '호주', share: 80 });
  const hr = r.items.find(i => i.id === 'hr');
  assert.strictEqual(hr.tons, 100060);                   // 50,000 + 30,000 + 20,000t(kg 환산) + 후판 60t(7208.51은 7208에 포함), 개수 단위 제외
  assert.strictEqual(hr.unitPriceJpy, 100030);           // (5,000,000+2,700,000+2,300,000+9,000)천엔 / 100,060t
  assert.strictEqual(hr.skippedCodes, 1);
  const plate = r.items.find(i => i.id === 'plate');
  assert.strictEqual(plate.lowVolume, true);
  assert.strictEqual(r.items.find(i => i.id === 'al').status, 'nodata');
  assert.ok(r.credit.includes('e-Stat'));
  const again = await svc.latest();
  assert.strictEqual(again, r);
  const out = JSON.stringify(r) + logs.join('\n');
  assert.ok(!out.includes(FAKE_ID));
});
