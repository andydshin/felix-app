'use strict';
const test = require('node:test');
const assert = require('node:assert');
const KEY = 'KOSIS_FAKE_KEY_DO_NOT_LEAK==';
process.env.KOSIS_API_KEY = KEY;
const { createKosis, pickTable, matchItems } = require('../lib/kosis');
const { makeKrPpiHandler } = require('../lib/kosis-handler');

const SEARCH = [
  { ORG_ID: '301', TBL_ID: 'DT_SPECIAL', TBL_NM: '생산자물가지수(특수분류)', STAT_NM: '생산자물가조사' },
  { ORG_ID: '301', TBL_ID: 'DT_BASIC', TBL_NM: '생산자물가지수(기본분류)(2020=100)', STAT_NM: '생산자물가조사' },
  { ORG_ID: '101', TBL_ID: 'DT_OTHER', TBL_NM: '소비자물가지수', STAT_NM: 'x' }
];
const META = [
  { OBJ_ID: 'ITEM', OBJ_NM: '항목', ITM_ID: 'T1', ITM_NM: '지수' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A1', ITM_NM: '총지수' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A101', ITM_NM: '철근' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A102', ITM_NM: '형강' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A103', ITM_NM: '열간압연강대' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A104', ITM_NM: '냉연강판' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A105', ITM_NM: '용융아연도강판' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A106', ITM_NM: '중후판' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A107', ITM_NM: '강관' },
  { OBJ_ID: 'A', OBJ_NM: '계정코드별', ITM_ID: 'A108', ITM_NM: '스테인리스강관' }   // 판재가 없으면 못 찾아야 맞다
];

test('표 고르기: 기본분류 우선, 특수분류 제외', () => {
  assert.strictEqual(pickTable(SEARCH).best.tblId, 'DT_BASIC');
});

test('품목 찾기: 정확히 같은 이름 → 포함, 엉뚱한 품목은 고르지 않음', () => {
  const m = matchItems(META).matches;
  assert.strictEqual(m.kr1.code, 'A101');
  assert.strictEqual(m.kr3.name, '열간압연강대');
  assert.strictEqual(m.kr5.name, '용융아연도강판');
  assert.strictEqual(m.kr8, null);
  assert.strictEqual(m.kr1.level, 1);
});

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url); const p = Object.fromEntries(u.searchParams);
    assert.strictEqual(p.apiKey, KEY);
    const ok = b => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
    if (u.pathname.endsWith('/statisticsSearch.do')) return ok(SEARCH);
    if (u.pathname.endsWith('/statisticsData.do')) return ok(META);
    if (u.pathname.endsWith('/statisticsParameterData.do')) {
      assert.strictEqual(p.tblId, 'DT_BASIC');
      if (p.objL1 === 'A107') return ok({ err: '30', errMsg: '데이터가 존재하지 않습니다.' });
      const base = { A101: 118, A102: 121, A103: 124, A104: 119, A105: 122, A106: 126 }[p.objL1];
      return ok([['202606', base - 1], ['202608', base + 0.6], ['202607', base]].map(([d, v]) => ({ PRD_DE: d, DT: String(v), UNIT_NM: '2020=100', ITM_NM: '지수' })));
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

test('국내 PPI: 최신 월·전월비, 없는 품목은 nodata, 키 비노출, 캐시', async () => {
  const calls = [];
  const svc = createKosis({ fetch: fakeFetch(calls), log: () => {} });
  const r = await svc.latest();
  assert.strictEqual(r.period, '2026-08');
  const rebar = r.items.find(i => i.id === 'kr1');
  assert.deepStrictEqual([rebar.value, rebar.prev, rebar.change], [118.6, 118, 0.6]);
  assert.strictEqual(r.items.find(i => i.id === 'kr7').status, 'nodata');
  assert.strictEqual(r.items.find(i => i.id === 'kr8').reason, 'item_not_found');
  const n = calls.length;
  await svc.latest();
  assert.strictEqual(calls.length, n);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('키 오류 응답은 502, 메시지에 키 없음', async () => {
  const f = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ err: '11', errMsg: '인증키가 유효하지 않습니다 ' + KEY }) });
  let got;
  await makeKrPpiHandler(createKosis({ fetch: f, log: () => {} }), () => {})((s, b) => { got = { s, b }; });
  assert.strictEqual(got.s, 502);
  assert.ok(!JSON.stringify(got.b).includes(KEY));
});
