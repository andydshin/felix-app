'use strict';
// 실행: node --test test/   (실제 Census를 호출하지 않는다. 가짜 fetch를 주입한다.)
const test = require('node:test');
const assert = require('node:assert');

const FAKE_KEY = 'TEST_KEY_DO_NOT_LEAK_123';
process.env.CENSUS_API_KEY = FAKE_KEY;
const { unitPrice, sumRecords, createService, ConfigError, monthsBack, prevMonth } = require('../lib/census');

// 사용자가 실제로 확인한 TX, 2026-08, HS 721070 응답값
const VERIFIED = { GEN_VAL_MO: '15391630', VES_VAL_MO: '15017927', AIR_VAL_MO: '0', VES_WGT_MO: '13960234', AIR_WGT_MO: '0' };

test('단가 = (해상+항공 금액) / (해상+항공 중량) * 1000, 검증값 1075.76', () => {
  const r = unitPrice(VERIFIED);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.unitPrice, 1075.76);
});

test('GEN_VAL_MO(전체 수입액)는 계산에 쓰지 않는다', () => {
  const r = unitPrice(Object.assign({}, VERIFIED, { GEN_VAL_MO: '99999999999' }));
  assert.strictEqual(r.unitPrice, 1075.76);
});

test('중량이 0이거나 자료가 없으면 자료 없음', () => {
  assert.strictEqual(unitPrice({ VES_VAL_MO: '100', AIR_VAL_MO: '0', VES_WGT_MO: '0', AIR_WGT_MO: '0' }).status, 'nodata');
  assert.strictEqual(unitPrice(null).status, 'nodata');
});

test('여러 HS코드는 분자·분모를 각각 합산한다 (강관)', () => {
  const s = sumRecords([{ VES_VAL_MO: '1000', AIR_VAL_MO: '0', VES_WGT_MO: '1000', AIR_WGT_MO: '0' }, null, { VES_VAL_MO: '3000', AIR_VAL_MO: '0', VES_WGT_MO: '1000', AIR_WGT_MO: '0' }]);
  assert.strictEqual(unitPrice(s).unitPrice, 2000);
});

test('월 계산', () => {
  assert.deepStrictEqual(monthsBack(new Date(Date.UTC(2026, 9, 12)), 2), ['2026-09', '2026-08']);
  assert.strictEqual(prevMonth('2026-01'), '2025-12');
});

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    if (p.key !== FAKE_KEY) return resp(403, 'invalid key');
    if (p.time === '2026-09') return resp(204, '');
    if (p.I_COMMODITY === '72') return resp(200, JSON.stringify([['GEN_VAL_MO', 'STATE', 'I_COMMODITY', 'time'], ['1', 'TX', '72', p.time]]));
    if (p.I_COMMODITY === '7210' && p.time === '2026-08') return row(p, VERIFIED);
    if (p.I_COMMODITY === '7210' && p.time === '2026-07') return row(p, { GEN_VAL_MO: '1', VES_VAL_MO: '1000000', AIR_VAL_MO: '0', VES_WGT_MO: '1000000', AIR_WGT_MO: '0' });
    if (p.I_COMMODITY === '7208') return row(p, { GEN_VAL_MO: '5', VES_VAL_MO: '5', AIR_VAL_MO: '0', VES_WGT_MO: '0', AIR_WGT_MO: '0' });
    return resp(204, '');
  };
}
function row(p, v) {
  const head = ['I_COMMODITY_SDESC', 'GEN_VAL_MO', 'VES_VAL_MO', 'AIR_VAL_MO', 'VES_WGT_MO', 'AIR_WGT_MO', 'STATE', 'time', 'I_COMMODITY'];
  return resp(200, JSON.stringify([head, ['DESC', v.GEN_VAL_MO, v.VES_VAL_MO, v.AIR_VAL_MO, v.VES_WGT_MO, v.AIR_WGT_MO, p.STATE, p.time, p.I_COMMODITY]]));
}
function resp(status, body) { return { status, ok: status >= 200 && status < 300, text: async () => body }; }

test('최신 월 탐색: 9월 자료가 없으면 8월을 쓰고, 값은 만들지 않는다', async () => {
  const calls = [], logs = [];
  const svc = createService({ fetch: fakeFetch(calls), now: () => new Date(Date.UTC(2026, 9, 12)), log: (m) => logs.push(m) });
  const d = await svc.stateImports('TX');
  assert.strictEqual(d.month, '2026-08');
  assert.strictEqual(d.prevMonth, '2026-07');
  const coated = d.items.find(i => i.id === 'coated');
  assert.strictEqual(coated.unitPrice, 1075.76);
  assert.strictEqual(coated.prev.unitPrice, 1000);
  assert.strictEqual(d.items.find(i => i.id === 'hr').status, 'nodata');
  assert.strictEqual(d.items.find(i => i.id === 'al').status, 'nodata');
  const again = await svc.stateImports('TX');
  assert.strictEqual(again.cache, 'hit');
  const body = JSON.stringify(d) + JSON.stringify(again) + logs.join('\n');
  assert.ok(!body.includes(FAKE_KEY), '응답·로그에 키가 없어야 한다');
  assert.ok(calls.every(c => c.includes('key=')), '키는 서버→Census 요청에만 붙는다');
});

test('키가 없으면 설정 오류(키 미노출)', async () => {
  const saved = process.env.CENSUS_API_KEY;
  delete process.env.CENSUS_API_KEY;
  const svc = createService({ fetch: fakeFetch([]) });
  await assert.rejects(() => svc.stateImports('TX'), ConfigError);
  process.env.CENSUS_API_KEY = saved;
});

test('지원하지 않는 주는 거절', async () => {
  const svc = createService({ fetch: fakeFetch([]) });
  await assert.rejects(() => svc.stateImports('ZZ'), (e) => e.code === 'BAD_STATE');
});
