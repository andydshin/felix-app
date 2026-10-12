'use strict';
// 실행: node --test test/   (실제 e-Stat을 호출하지 않는다. 가짜 fetch를 주입한다.)
const test = require('node:test');
const assert = require('node:assert');

const FAKE_ID = 'ESTAT_FAKE_APPID_DO_NOT_LEAK';
process.env.ESTAT_APP_ID = FAKE_ID;
const { createEstat, EstatConfigError, EstatUpstreamError, arr } = require('../lib/estat');
const { makeProbeHandler } = require('../lib/estat-handler');

function resp(obj) { return { status: 200, ok: true, text: async () => JSON.stringify(obj) }; }

function fakeFetch(calls, opts) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const method = u.pathname.split('/').pop();
    const p = Object.fromEntries(u.searchParams);
    if (p.appId !== FAKE_ID) return resp({ GET_STATS_LIST: { RESULT: { STATUS: 100, ERROR_MSG: '認証に失敗しました。' } } });
    if (method === 'getStatsList') return resp({ GET_STATS_LIST: { RESULT: { STATUS: 0 }, DATALIST_INF: { NUMBER: 3, TABLE_INF: [
      { '@id': '0003425293', TITLE: { '@no': '1', $: '品別国別表 輸出' }, STATISTICS_NAME: '普通貿易統計', CYCLE: '月次', SURVEY_DATE: '202501-202512', UPDATED_DATE: '2026-03-01', OVERALL_TOTAL_NUMBER: 1000 },
      { '@id': '0003425294', TITLE: { '@no': '2', $: '品別国別表 輸入' }, STATISTICS_NAME: '普通貿易統計', CYCLE: '月次', SURVEY_DATE: '202501-202512', UPDATED_DATE: '2026-03-01', OVERALL_TOTAL_NUMBER: 1000 },
      { '@id': '0003000001', TITLE: '品別国別表 輸出', STATISTICS_NAME: '普通貿易統計', SURVEY_DATE: '202001-202012', UPDATED_DATE: '2021-03-01' }
    ] } } });
    if (method === 'getMetaInfo') return resp({ GET_META_INFO: { RESULT: { STATUS: 0 }, METADATA_INF: { CLASS_INF: { CLASS_OBJ: [
      { '@id': 'tab', '@name': '表章項目', CLASS: [{ '@code': '100', '@name': '数量1' }, { '@code': '120', '@name': '金額', '@unit': '千円' }] },
      { '@id': 'cat01', '@name': '品目', CLASS: [{ '@code': '010121100', '@name': '馬' }, { '@code': '720827000', '@name': '熱延コイル' }] },
      { '@id': 'area', '@name': '国', CLASS: { '@code': '103', '@name': '韓国' } }
    ] } } } });
    if (method === 'getStatsData') {
      if (opts && opts.dataFails) return { status: 500, ok: false, text: async () => '' };
      assert.strictEqual(p.cdCat01, '720827000');
      return resp({ GET_STATS_DATA: { RESULT: { STATUS: 0 }, STATISTICAL_DATA: { RESULT_INF: { TOTAL_NUMBER: 2 }, DATA_INF: { VALUE: [
        { '@tab': '100', '@cat01': '720827000', '@area': '103', '@time': '2025000000', '@unit': 'MT', $: '1200' },
        { '@tab': '120', '@cat01': '720827000', '@area': '103', '@time': '2025000000', '@unit': '千円', $: '98000' }
      ] } } } });
    }
    return { status: 404, ok: false, text: async () => '' };
  };
}

test('단일 원소 객체도 배열로 다룬다', () => {
  assert.deepStrictEqual(arr({ a: 1 }), [{ a: 1 }]);
  assert.deepStrictEqual(arr(undefined), []);
});

test('진단: 최신 수출·수입 표를 고르고 구조·샘플 값을 돌려준다, 앱 ID는 어디에도 없다', async () => {
  const calls = [], logs = [];
  const svc = createEstat({ fetch: fakeFetch(calls), log: m => logs.push(m) });
  const r = await svc.probe();
  assert.strictEqual(r.tableCount, 3);
  assert.strictEqual(r.latest.export.table.id, '0003425293');
  assert.strictEqual(r.latest.import.table.id, '0003425294');
  const cat = r.latest.export.dimensions.find(d => d.id === 'cat01');
  assert.strictEqual(cat.sampleSteel[0].code, '720827000');
  assert.strictEqual(r.latest.export.dimensions.find(d => d.id === 'area').count, 1);
  assert.strictEqual(r.latest.import.sample.values.length, 2);
  assert.ok(r.credit.includes('e-Stat'));
  const out = JSON.stringify(r) + logs.join('\n');
  assert.ok(!out.includes(FAKE_ID));
  assert.ok(calls.every(c => c.includes('appId=')));
});

test('샘플 값 조회가 실패해도 진단은 계속된다', async () => {
  const r = await createEstat({ fetch: fakeFetch([], { dataFails: true }), log: () => {} }).probe();
  assert.ok(r.latest.export.sample.error);
  assert.ok(r.latest.export.dimensions.length === 3);
});

test('앱 ID가 틀리면 upstream 오류, 메시지에 ID 없음', async () => {
  const saved = process.env.ESTAT_APP_ID;
  const svc = createEstat({ fetch: fakeFetch([]), log: () => {} });
  process.env.ESTAT_APP_ID = 'WRONG';
  await assert.rejects(() => svc.probe(), e => e instanceof EstatUpstreamError && !String(e.detail).includes('WRONG'));
  process.env.ESTAT_APP_ID = saved;
});

test('앱 ID가 없으면 503 not_configured', async () => {
  const saved = process.env.ESTAT_APP_ID;
  delete process.env.ESTAT_APP_ID;
  const handle = makeProbeHandler(createEstat({ fetch: fakeFetch([]) }), () => {});
  let got;
  await handle((s, b) => { got = { s, b }; });
  assert.strictEqual(got.s, 503);
  process.env.ESTAT_APP_ID = saved;
  await assert.rejects(() => createEstat({ fetch: fakeFetch([]) }).probe().then(() => { delete process.env.ESTAT_APP_ID; return createEstat({ fetch: fakeFetch([]) }).probe(); }), EstatConfigError);
  process.env.ESTAT_APP_ID = saved;
});

test('핸들러는 결과를 1시간 캐시한다', async () => {
  const calls = [];
  const handle = makeProbeHandler(createEstat({ fetch: fakeFetch(calls), log: () => {} }), () => {});
  let a, b;
  await handle((s, body) => { a = body; });
  const n = calls.length;
  await handle((s, body) => { b = body; });
  assert.strictEqual(calls.length, n);
  assert.strictEqual(b.cache, 'hit');
});
