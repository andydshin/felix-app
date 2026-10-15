'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.CUSTOMS_SERVICE_KEY = 'ck-test'; delete process.env.COMTRADE_API_KEY;
const { createHsTrade, shape, codesOf } = require('../lib/hstrade');

test('HS 코드 정리와 월·상대국·코드별 집계', () => {
  assert.deepStrictEqual(codesOf('7210.12, 721011 abc 72'), ['721012', '721011']);
  const s = shape([{ ym: '202607', code: '721012', partner: 'CN', kg: 2000000, usd: 1800000 }, { ym: '202607', code: '721011', partner: 'CN', kg: 1000000, usd: 950000 }, { ym: '202608', code: '721012', partner: 'KR', kg: 500000, usd: 600000 }], ['CN', 'KR'], ['721012', '721011']);
  assert.deepStrictEqual(s.months, ['2026-07', '2026-08']);
  assert.deepStrictEqual(s.series.CN.total[0], { ym: '202607', t: 3000, usd: 2750000, unit: 916.7 });
  assert.strictEqual(s.series.CN.byCode['721011'][0].t, 1000);
  assert.strictEqual(s.series.KR.total[0].unit, null);
});

test('멕시코 수입(Comtrade 미리보기) + 한국 대멕시코 수출(관세청), 키는 URL에 없음', async () => {
  const urls = [];
  const f = async (url, o) => {
    urls.push({ url, h: o && o.headers });
    if (url.includes('comtrade')) return new URL(url).searchParams.get('period') !== '202607' ? { ok: true, status: 200, text: async () => '{"data":[]}' } : { ok: true, status: 200, text: async () => JSON.stringify({ data: [
      { period: '202607', partnerCode: 156, cmdCode: '721012', netWgt: 3000000, primaryValue: 2700000 },
      { period: '202607', partnerCode: 410, cmdCode: '721012', netWgt: 1000000, primaryValue: 1050000 },
      { period: '202607', partnerCode: 0, cmdCode: '721012', netWgt: 8000000, primaryValue: 7600000 } ] }) };
    return { ok: true, status: 200, text: async () => '<response><header><resultCode>00</resultCode></header><body><items><item><year>2026.07</year><hsCd>721012</hsCd><statCd>MX</statCd><expWgt>990000</expWgt><expDlr>980000</expDlr></item><item><year>총계</year></item></items></body></response>' };
  };
  const r = await createHsTrade({ fetch: f, now: () => new Date('2026-10-15T00:00:00Z') }).search({ preset: 'tinplate', market: 'MX', partners: 'CN,KR' });
  assert.deepStrictEqual(r.codes, ['721011', '721012', '721210']);
  assert.strictEqual(r.main.series.CN.total.find(x => x.ym === '202607').unit, 900);
  assert.strictEqual(r.main.series.WD.total[0].t, 8000);
  assert.strictEqual(r.koreaExport.series.KR.total[0].unit, 989.9);
  const ct = urls.find(u => u.url.includes('comtrade')).url;
  assert.ok(ct.includes('/public/v1/preview/') && ct.includes('reporterCode=484') && ct.includes('partnerCode=156%2C410%2C0'));
  assert.ok(urls.every(u => !u.url.includes('ck-test') || u.url.includes('apis.data.go.kr')));
  await assert.rejects(createHsTrade({ fetch: f }).search({ codes: '12' }), e => e.status === 'bad_codes');
});

test('Comtrade 미리보기는 달마다 나눠 묻고, 일부 실패해도 나머지를 쓴다', async () => {
  const seen = [];
  const f = async (url) => {
    if (!url.includes('comtrade')) return { ok: true, status: 200, text: async () => '<response><header><resultCode>00</resultCode></header><body><items></items></body></response>' };
    const per = new URL(url).searchParams.get('period'); seen.push(per);
    if (per.includes(',')) return { ok: false, status: 400, text: async () => '{"error":"Maximum number of periods for preview is 1"}' };
    if (per === '202601') return { ok: false, status: 500, text: async () => 'x' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ period: per, partnerCode: 156, cmdCode: '721012', netWgt: 1000000, primaryValue: 900000 }] }) };
  };
  const r = await createHsTrade({ fetch: f, now: () => new Date('2026-10-15T00:00:00Z') }).comtrade('MX', ['CN', 'WD'], ['721012'], 'import', 12);
  assert.strictEqual(seen.length, 12);
  assert.ok(seen.every(p => /^\d{6}$/.test(p)));
  assert.strictEqual(r.rows.length, 11);
  assert.deepStrictEqual(r.failed, [{ period: '202601', status: '500' }]);
});
