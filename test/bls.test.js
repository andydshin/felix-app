'use strict';
const test = require('node:test');
const assert = require('node:assert');
const KEY = 'BLS_FAKE_KEY_DO_NOT_LEAK';
process.env.BLS_API_KEY = KEY;
const { createBls } = require('../lib/bls');
const { makeUsPpiHandler } = require('../lib/bls-handler');

const ser = (id, t, pts) => ({ seriesID: id, catalog: { series_title: t }, data: pts.map(([y, p, v, prelim]) => ({ year: y, period: p, value: String(v), footnotes: prelim ? [{ code: 'P', text: 'preliminary' }] : [{}] })) });
const SERIES = [
  ser('WPU1017', 'PPI Commodity data for Metals and metal products-Steel mill products, not seasonally adjusted', [['2026', 'M08', 381.162, true], ['2026', 'M07', 374.793], ['2025', 'M13', 360]]),
  ser('WPU101707', 'PPI Commodity data for Metals and metal products-Cold rolled steel sheet and strip, not seasonally adjusted', [['2026', 'M08', 469.251], ['2026', 'M07', 446.617]]),
  ser('WPU1012', 'PPI Commodity data for Metals and metal products-Iron and steel scrap', [['2026', 'M08', 580.548], ['2026', 'M07', 589.583]])
];

test('BLS: 시리즈 선택(제목으로 냉연 찾기), 최신·전월, 예비치 표시, 키는 본문에만', async () => {
  const bodies = [];
  const fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'REQUEST_SUCCEEDED', message: [], Results: { series: SERIES } }) }; };
  const r = await createBls({ fetch, now: () => new Date(Date.UTC(2026, 9, 13)), log: () => {} }).latest();
  assert.strictEqual(bodies[0].registrationkey, KEY);
  assert.deepStrictEqual([bodies[0].startyear, bodies[0].endyear], ['2024', '2026']);
  const [g1, g2, g3, g4] = r.items;
  assert.strictEqual(g4.status, 'nodata');
  assert.deepStrictEqual([g1.value, g1.prev, g1.preliminary, g1.period], [381.162, 374.793, true, '2026-08']);
  assert.strictEqual(g2.seriesId, 'WPU101707');
  assert.deepStrictEqual(bodies[0].seriesid, ['WPU1017', 'WPU101707', 'WPU1012', 'WPU101704', 'WPU101706']);
  assert.strictEqual(g3.change, -9.035);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('REQUEST_FAILED면 다시 묻고, 마지막엔 제목 없이 묻는다', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (bodies.length < 3) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'REQUEST_FAILED', message: ['Your request has failed.'] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'REQUEST_SUCCEEDED', message: [], Results: { series: SERIES.map(s => Object.assign({}, s, { catalog: undefined })) } }) };
  };
  const r = await createBls({ fetch, now: () => new Date(Date.UTC(2026, 9, 13)), log: () => {}, wait: async () => {} }).latest();
  assert.strictEqual(bodies.length, 3);
  assert.strictEqual(bodies[2].catalog, undefined);
  assert.strictEqual(r.items.filter(i => i.status === 'ok').length, 3);   // 가짜 응답에 gl4·gl5는 없음
});

test('BLS 오류 응답은 502, 키 비노출', async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'REQUEST_NOT_PROCESSED', message: ['Invalid key ' + KEY] }) });
  let got;
  await makeUsPpiHandler(createBls({ fetch, log: () => {}, wait: async () => {} }), () => {})((s, b) => { got = { s, b }; });
  assert.strictEqual(got.s, 502);
  assert.ok(!JSON.stringify(got.b).includes(KEY));
});
