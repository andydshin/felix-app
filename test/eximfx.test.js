'use strict';
const test = require('node:test');
const assert = require('node:assert');
const KEY = 'KEXIM_FAKE_KEY_DO_NOT_LEAK';
process.env.KOREAEXIM_API_KEY = KEY;
const { createEximFx, EximUpstreamError } = require('../lib/eximfx');
const { makeFxDailyHandler } = require('../lib/eximfx-handler');

const rows = (usd, cnh, jpy) => [
  { result: 1, cur_unit: 'USD', deal_bas_r: usd, cur_nm: '미국 달러' },
  { result: 1, cur_unit: 'CNH', deal_bas_r: cnh, cur_nm: '위안화' },
  { result: 1, cur_unit: 'JPY(100)', deal_bas_r: jpy, cur_nm: '일본 옌' },
  { result: 1, cur_unit: 'EUR', deal_bas_r: '1,520.1', cur_nm: '유로' }
];

function fake(calls, data) {
  return async (url) => {
    calls.push(url);
    const p = Object.fromEntries(new URL(url).searchParams);
    assert.strictEqual(p.authkey, KEY);
    assert.strictEqual(p.data, 'AP01');
    const body = data[p.searchdate];
    return { ok: true, status: 200, text: async () => JSON.stringify(body === undefined ? [] : body) };
  };
}

test('최근 영업일: 오늘(11시 전) 빈 응답이면 전날, 주말은 건너뛰고 그 전 영업일', async () => {
  const calls = [];
  // 2026-10-13(화) 09:00 KST = 10-13 00:00 UTC. 10/12(월) 값, 10/09(금) 값.
  const svc = createEximFx({ fetch: fake(calls, { '20261012': rows('1,349.5', '201.3', '853.2'), '20261009': rows('1,352.0', '201.9', '858.1') }), now: () => new Date(Date.UTC(2026, 9, 13, 0, 0)) });
  const r = await svc.latest();
  assert.deepStrictEqual([r.date, r.prevDate], ['2026-10-12', '2026-10-09']);
  assert.deepStrictEqual(r.rates, { USD: 1349.5, CNH: 201.3, JPY100: 853.2 });
  assert.strictEqual(r.prevRates.USD, 1352);
  assert.ok(!calls.some(c => /searchdate=2026101[01]/.test(c)));   // 토·일은 묻지 않음
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('인증 오류(result 3)는 502, 메시지에 키 없음', async () => {
  const f = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ result: 3 }]) });
  let got;
  await makeFxDailyHandler(createEximFx({ fetch: f, now: () => new Date(Date.UTC(2026, 9, 13, 5)) }), () => {})((s, b) => { got = { s, b }; });
  assert.strictEqual(got.s, 502);
  assert.strictEqual(got.b.status, 'result-3');
  assert.ok(!JSON.stringify(got.b).includes(KEY));
});

test('연결 실패(해외 접속 차단 등)는 진단에 원인 코드를 남긴다', async () => {
  const f = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; };
  const p = await createEximFx({ fetch: f, now: () => new Date(Date.UTC(2026, 9, 13, 5)) }).probe();
  assert.strictEqual(p.results[0].ok, false);
  assert.strictEqual(p.results[0].cause, 'ECONNRESET');
});
