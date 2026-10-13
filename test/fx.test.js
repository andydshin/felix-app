'use strict';
const test = require('node:test');
const assert = require('node:assert');
const KEY = 'FX_FAKE_KEY_DO_NOT_LEAK';
process.env.CUSTOMS_SERVICE_KEY = KEY;
const { createFx, pick, sundayOf } = require('../lib/fx');
const { makeJpTradeHandler } = require('../lib/estat-handler');

const xml = items => '<response><header><resultCode>00</resultCode><resultMsg>정상</resultMsg></header><body><items>'
  + items.map(([c, r]) => '<item><aplyBgnDt>x</aplyBgnDt><cntySgn>' + c.slice(0, 2) + '</cntySgn><currSgn>' + c + '</currSgn><fxrt>' + r + '</fxrt><imexTp>2</imexTp></item>').join('') + '</items></body></response>';

test('통화 고르기: 엔은 100엔 기준으로 맞춘다', () => {
  assert.deepStrictEqual(pick([{ currSgn: 'USD', fxrt: '1,380.5' }, { currSgn: 'JPY', fxrt: '9.3' }, { currSgn: 'CNY', fxrt: '190.1' }, { currSgn: 'EUR', fxrt: '1500' }]), { USD: 1380.5, JPY100: 930, CNY: 190.1 });
  assert.strictEqual(pick([{ currSgn: 'JPY', fxrt: '930.12' }]).JPY100, 930.12);
});

test('주 시작일은 일요일', () => {
  assert.strictEqual(sundayOf(new Date(Date.UTC(2026, 9, 13))).toISOString().slice(0, 10), '2026-10-11');
});

function fakeFetch(calls, opts) {
  return async (url) => {
    calls.push(url);
    const p = Object.fromEntries(new URL(url).searchParams);
    assert.strictEqual(p.serviceKey, KEY);
    assert.strictEqual(p.weekFxrtTpcd, '2');
    if (opts && opts.emptyAfter && p.aplyBgnDt > opts.emptyAfter) return { ok: true, status: 200, text: async () => xml([]) };
    const d = Number(p.aplyBgnDt.slice(6));
    const m = Number(p.aplyBgnDt.slice(4, 6));
    return { ok: true, status: 200, text: async () => xml([['USD', 1400 + m], ['CNY', 195], ['JPY', 950 + d / 100]]) };
  };
}

test('최신 주: 이번 주 고시가 없으면 지난주로, 월평균은 그 달 일요일들', async () => {
  const calls = [];
  const fx = createFx({ fetch: fakeFetch(calls, { emptyAfter: '20261004' }), now: () => new Date(Date.UTC(2026, 9, 13)) });
  const l = await fx.latest();
  assert.strictEqual(l.week, '2026-10-04');
  assert.strictEqual(l.prevWeek, '2026-09-27');
  assert.strictEqual(l.rates.USD, 1410);
  const a = await fx.monthAvg('2026-08');                // 8/2, 8/9, 8/16, 8/23, 8/30
  assert.strictEqual(a.weeks, 5);
  assert.strictEqual(a.USD, 1408);
  assert.ok(!JSON.stringify([l, a]).includes(KEY));
});

test('일본 엔/t를 월평균 환율로 달러/t 환산', async () => {
  const fx = createFx({ fetch: fakeFetch([]), now: () => new Date(Date.UTC(2026, 9, 13)) });
  const jp = { latest: async () => ({ items: [{ id: 'hr', status: 'ok', month: '2026-08', unitPriceJpy: 100000, prev: { status: 'ok', unitPriceJpy: 98000 } }, { id: 'al', status: 'nodata' }] }) };
  let out;
  await makeJpTradeHandler(jp, () => {}, fx)((s, b) => { out = b; });
  const a = await fx.monthAvg('2026-08');
  assert.strictEqual(out.items[0].unitPriceUsd, Math.round(100000 * (a.JPY100 / 100 / a.USD) * 100) / 100);
  assert.ok(out.items[0].prev.unitPriceUsd > 0);
  assert.strictEqual(out.items[1].unitPriceUsd, undefined);
  assert.strictEqual(out.fx.months.length, 2);
});
