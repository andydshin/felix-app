'use strict';
const test = require('node:test');
const assert = require('node:assert');
const KEY = 'CENSUS_FAKE_MX_KEY';
process.env.CENSUS_API_KEY = KEY;
const { createMxTrade, aggregate } = require('../lib/mxtrade');

const H = ['I_COMMODITY', 'GEN_VAL_MO', 'GEN_QY1_MO', 'UNIT_QY1', 'COMM_LVL', 'CTY_CODE', 'time'];
const row = (c, v, q, u, t) => [c, String(v), String(q), u, 'HS10', '2010', t];

test('집계: KG·T 환산, 개수 단위 제외, 물량 적음', () => {
  const rows = [
    { I_COMMODITY: '7208100000', GEN_VAL_MO: '600000', GEN_QY1_MO: '1000000', UNIT_QY1: 'KG' },
    { I_COMMODITY: '7208270000', GEN_VAL_MO: '700000', GEN_QY1_MO: '1000', UNIT_QY1: 'T' },
    { I_COMMODITY: '7208900000', GEN_VAL_MO: '9999', GEN_QY1_MO: '5', UNIT_QY1: 'NO' },
    { I_COMMODITY: '7502100000', GEN_VAL_MO: '800000', GEN_QY1_MO: '50000', UNIT_QY1: 'KG' }
  ];
  const a = aggregate(rows);
  assert.deepStrictEqual([a.hr.tons, a.hr.unitPrice, a.hr.skipped], [2000, 650, 1]);
  assert.strictEqual(a.ni.lowVolume, true);
  assert.strictEqual(a.cr.status, 'nodata');
});

test('최신 월 탐색(204면 이전 달), 전월, 키는 요청에만', async () => {
  const urls = [];
  const f = async (url) => {
    urls.push(url);
    const p = Object.fromEntries(new URL(url).searchParams);
    assert.strictEqual(p.CTY_CODE, '2010');
    if (p.time === '2026-09') return { status: 204, ok: true, text: async () => '' };
    const v = p.time === '2026-08' ? 650000 : 600000;
    return { status: 200, ok: true, text: async () => JSON.stringify([H, row('7208100000', v, 1000, 'T', p.time)]) };
  };
  const r = await createMxTrade({ fetch: f, now: () => new Date(Date.UTC(2026, 9, 13)), log: () => {} }).latest();
  assert.strictEqual(r.month, '2026-08');
  assert.deepStrictEqual([r.items.hr.unitPrice, r.items.hr.prev.unitPrice], [650, 600]);
  assert.ok(!JSON.stringify(r).includes(KEY));
});
