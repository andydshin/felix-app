'use strict';
// 실제 관세청 응답 형식(2026-10-13 진단 결과)을 본뜬 가짜 fetch로 한국 수입 단가 계산을 검증한다.
const test = require('node:test');
const assert = require('node:assert');
const KEY = 'KR_FAKE_KEY_DO_NOT_LEAK';
process.env.CUSTOMS_SERVICE_KEY = KEY;
const { createKrTrade, aggregate } = require('../lib/krtrade');

const item = (year, cc, name, hs, impWgt, impDlr) => '<item><balPayments>0</balPayments><expDlr>0</expDlr><expWgt>0</expWgt><hsCd>' + hs + '</hsCd><impDlr>' + impDlr + '</impDlr><impWgt>' + impWgt + '</impWgt><statCd>' + cc + '</statCd><statCdCntnKor1>' + name + '</statCdCntnKor1><statKor>x</statKor><year>' + year + '</year></item>';
const xml = items => '<response><header><resultCode>00</resultCode><resultMsg>정상서비스.</resultMsg></header><body><items>' + items.join('') + '</items></body></response>';

const ROWS_7208 = [
  item('총계', '-', '-', '-', 999999999999, 999999999), // 기간 합계: 쓰지 않는다
  item('2026.09', 'CN', '중국', '7208519000', 70008452, 43419714),
  item('2026.09', 'CN', '중국', '7208511000', 4125099, 3417085),
  item('2026.09', 'JP', '일본', '720839', 81038050, 42977758),
  item('2026.09', 'TW', '대만', '720827', 1000000, 600000),
  item('2026.08', 'CN', '중국', '7208519000', 49748941, 34975077),
  item('2026.08', 'JP', '일본', '720839', 60000000, 33000000),
  item('2026.08', 'XX', '기타', '720490', 5000000, 1)  // 다른 HS가 섞이면 버린다
];

test('aggregate: 총계 행·다른 HS 제외, 월·국가별 합산', () => {
  const rows = require('../lib/customs').parseXml(xml(ROWS_7208)).items;
  const m = aggregate(rows, ['7208']);
  assert.deepStrictEqual(Object.keys(m).sort(), ['2026-08', '2026-09']);
  assert.strictEqual(m['2026-09'].kg, 70008452 + 4125099 + 81038050 + 1000000);
  assert.strictEqual(m['2026-08'].byCountry.XX, undefined);
});

test('한국 수입 단가: 최신 월, 전월비용 전월, 중국산·일본산, 물량 적음, 키 비노출', async () => {
  const calls = [], logs = [];
  const fetch = async (url) => {
    calls.push(url);
    const p = Object.fromEntries(new URL(url).searchParams);
    assert.strictEqual(p.serviceKey, KEY);
    if (p.cntyCd) {                                     // 중국산 철강재 수입량만 국가 지정
      assert.deepStrictEqual([p.cntyCd, p.hsSgn], ['CN', '72']);
      return { ok: true, status: 200, text: async () => xml([item('2026.09', 'CN', '중국', '720851', 100000000, 60000000), item('2026.09', 'CN', '중국', '720449', 5000000, 1000000), item('2026.08', 'CN', '중국', '721070', 80000000, 50000000)]) };
    }
    assert.deepStrictEqual([p.strtYymm, p.endYymm], ['202606', '202610']);
    const body = p.hsSgn === '7208' ? xml(ROWS_7208)
      : p.hsSgn === '721633' ? xml([item('2026.09', 'CN', '중국', '7216331000', 50000, 40000)])
      : xml([]);
    return { ok: true, status: 200, text: async () => body };
  };
  const svc = createKrTrade({ fetch, now: () => new Date(Date.UTC(2026, 9, 13)), log: m => logs.push(m) });
  const r = await svc.latest();
  assert.strictEqual(r.month, '2026-09');
  assert.strictEqual(r.prevMonth, '2026-08');
  const hr = r.items.find(i => i.id === 'imp1');
  const kg = 70008452 + 4125099 + 81038050 + 1000000, usd = 43419714 + 3417085 + 42977758 + 600000;
  assert.strictEqual(hr.unitPrice, Math.round(usd / (kg / 1000) * 100) / 100);
  assert.strictEqual(hr.byCountry.CN.unitPrice, Math.round((43419714 + 3417085) / ((70008452 + 4125099) / 1000) * 100) / 100);
  assert.strictEqual(hr.byCountry.JP.unitPrice, 530.34);
  assert.strictEqual(hr.topPartners[0].name, '일본');
  assert.strictEqual(hr.prev.unitPrice, Math.round((34975077 + 33000000) / ((49748941 + 60000000) / 1000) * 100) / 100);
  const h = r.items.find(i => i.id === 'imp7');
  assert.strictEqual(h.lowVolume, true);
  assert.strictEqual(h.prev.status, 'nodata');
  assert.strictEqual(r.items.find(i => i.id === 'imp2').status, 'nodata');
  assert.strictEqual(calls.length, 18);
  assert.strictEqual(r.items.find(i => i.id === 'nf1').status, 'nodata');
  const sd = r.items.find(i => i.id === 'sd1');
  assert.strictEqual(sd.tons, 100000);                  // 스크랩(7204)은 빼고 철강재만
  assert.strictEqual(sd.prev.tons, 80000);
  await svc.latest();
  assert.strictEqual(calls.length, 18);                  // 캐시
  assert.ok(!(JSON.stringify(r) + logs.join('')).includes(KEY));
});
