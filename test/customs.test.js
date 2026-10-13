'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RAW = 'abc+DEF/ghi==';
process.env.CUSTOMS_SERVICE_KEY = encodeURIComponent(RAW); // 'Encoding' 키를 넣은 경우
const { createCustoms, parseXml, CustomsConfigError } = require('../lib/customs');
const { makeKrProbeHandler } = require('../lib/customs-handler');

const OK = '<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items>'
  + '<item><year>2026.08</year><statCd>CN</statCd><statCdCntnKor1>중국</statCdCntnKor1><hsCd>7208</hsCd><statKor>철 &amp; 비합금강 평판압연</statKor><impWgt>120000000</impWgt><impDlr>60000000</impDlr><expWgt>0</expWgt><expDlr>0</expDlr></item>'
  + '<item><year>총계</year><impWgt>120000000</impWgt></item></items><totalCount>2</totalCount></body></response>';
const GW_ERR = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';

test('XML 파싱: 항목·엔티티·결과코드', () => {
  const r = parseXml(OK);
  assert.strictEqual(r.resultCode, '00');
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].statKor, '철 & 비합금강 평판압연');
  assert.strictEqual(parseXml(GW_ERR).authMsg, 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR');
});

test('진단: 사례별 결과, 국가 생략 실패도 기록, 키 비노출, Encoding 키는 한 번 풀어 사용', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const p = Object.fromEntries(new URL(url).searchParams);
    assert.strictEqual(p.serviceKey, RAW);
    if (!p.cntyCd) return { ok: true, status: 200, text: async () => '<response><header><resultCode>10</resultCode><resultMsg>INVALID_REQUEST_PARAMETER_ERROR(' + RAW + ')</resultMsg></header></response>' };
    return { ok: true, status: 200, text: async () => OK };
  };
  const r = await createCustoms({ fetch, now: () => new Date(Date.UTC(2026, 9, 13)), log: () => {} }).probe();
  assert.deepStrictEqual(r.period, { start: '202606', end: '202609' });
  assert.strictEqual(r.results[0].ok, true);
  assert.strictEqual(r.results[0].items[0].impDlr, '60000000');
  const omit = r.results.find(x => x.label.startsWith('국가 생략'));
  assert.strictEqual(omit.ok, false);
  assert.strictEqual(omit.status, 'api-10');
  const out = JSON.stringify(r);
  assert.ok(!out.includes(RAW) && !out.includes(encodeURIComponent(RAW)));
});

test('키 없으면 503', async () => {
  const saved = process.env.CUSTOMS_SERVICE_KEY;
  delete process.env.CUSTOMS_SERVICE_KEY;
  let got;
  await makeKrProbeHandler(createCustoms({ fetch: async () => ({}) }), () => {})((s, b) => { got = { s, b }; });
  assert.strictEqual(got.s, 503);
  await assert.rejects(() => createCustoms({ fetch: async () => ({}) }).probe(), CustomsConfigError);
  process.env.CUSTOMS_SERVICE_KEY = saved;
});

test('게이트웨이 키 오류는 사례별 실패로 기록', async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => GW_ERR });
  const r = await createCustoms({ fetch, log: () => {} }).probe();
  assert.ok(r.results.every(x => !x.ok && x.status === 'gateway-30'));
});
