'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createEurostat, flatten } = require('../lib/eurostat');

// JSON-stat 2.0 만들기: dims = [[id, [codes...]], ...], val(fn of codes) → value
function js(dims, val) {
  const id = dims.map(d => d[0]), size = dims.map(d => d[1].length), dimension = {};
  dims.forEach(([k, codes]) => { const index = {}; codes.forEach((c, i) => { index[c] = i; }); dimension[k] = { category: { index } }; });
  const value = {}; let n = 0;
  const rec = (i, acc) => { if (i === dims.length) { const v = val(acc); if (v != null) value[n] = v; n++; return; } dims[i][1].forEach(c => rec(i + 1, Object.assign({}, acc, { [dims[i][0]]: c }))); };
  rec(0, {});
  return { id, size, dimension, value };
}

test('JSON-stat 펼치기', () => {
  const r = flatten(js([['a', ['x', 'y']], ['time', ['2026M07', '2026M08']]], c => (c.a === 'x' ? 1 : 2) * (c.time === '2026M08' ? 10 : 1)));
  assert.strictEqual(r.length, 4);
  assert.strictEqual(r.find(x => x.a === 'y' && x.time === '2026M08').value, 20);
});

test('Comext 단가(유로/t)와 PPI 보완, 최신 달은 값이 있는 마지막 달', async () => {
  const comextJs = js([['freq', ['M']], ['reporter', ['EU27_2020']], ['partner', ['EXT_EU27_2020']], ['product', ['7208', '7601', '7502']], ['flow', ['1']], ['indicators', ['QUANTITY_IN_100KG', 'VALUE_IN_EUROS']], ['time', ['2026M06', '2026M07', '2026M08']]],
    c => {
      if (c.time === '2026M08') return null;                                   // 8월은 아직 없음
      if (c.product === '7208') return c.indicators === 'VALUE_IN_EUROS' ? (c.time === '2026M07' ? 60000000 : 55000000) : 1000000; // 100kg → 100,000t
      if (c.product === '7601') return c.indicators === 'VALUE_IN_EUROS' ? 2600000 : 10000;   // 1,000t
      if (c.product === '7502') return c.indicators === 'VALUE_IN_EUROS' ? 500000 : 300;        // 30t → 물량 적음
      return null;
    });
  const ppiJs = js([['freq', ['M']], ['indic_bt', ['PRC_PRR_DOM']], ['nace_r2', ['C241', 'C2445']], ['s_adj', ['NSA']], ['unit', ['I21']], ['geo', ['EU27_2020']], ['time', ['2026M07', '2026M08']]],
    c => (c.nace_r2 === 'C241' ? 120 : 130) + (c.time === '2026M08' ? 1 : 0));
  const urls = [];
  const f = async (url) => { urls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('comext') ? comextJs : ppiJs) }; };
  const r = await createEurostat({ fetch: f, log: () => {} }).latest();
  assert.strictEqual(r.month, '2026-07');
  assert.deepStrictEqual([r.items.hr.comext.unitPrice, r.items.hr.comext.prev.unitPrice, r.items.hr.comext.tons], [600, 550, 100000]);
  assert.strictEqual(r.items.al.comext.unitPrice, 2600);
  assert.strictEqual(r.items.ni.comext.lowVolume, true);
  assert.deepStrictEqual([r.items.hr.ppi.nace, r.items.hr.ppi.value, r.items.hr.ppi.prev], ['C241', 121, 120]);
  assert.strictEqual(r.items.ni.ppi.value, 131);
  assert.ok(urls[0].includes('product=7208') && urls[0].includes('flow=1'));
});
