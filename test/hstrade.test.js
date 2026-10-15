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
  const r = await createHsTrade({ fetch: f, wait: () => Promise.resolve(), now: () => new Date('2026-10-15T00:00:00Z') }).search({ preset: 'tinplate', market: 'MX', partners: 'CN,KR' });
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
  const r = await createHsTrade({ fetch: f, wait: () => Promise.resolve(), now: () => new Date('2026-10-15T00:00:00Z') }).comtrade('MX', ['CN', 'WD'], ['721012'], 'import', 12);
  assert.strictEqual(seen.length, 12);
  assert.ok(seen.every(p => /^\d{6}$/.test(p)));
  assert.strictEqual(r.rows.length, 11);
  assert.deepStrictEqual(r.failed, [{ period: '202601', status: '500' }]);
});

test('429면 쉬었다 한 번 더 묻고, 계속 막히면 멈춘다', async () => {
  let n = 0;
  const f = async (url) => { n++; if (n === 1 || n >= 4) return { ok: false, status: 429, text: async () => 'rate' }; const per = new URL(url).searchParams.get('period'); return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ period: per, partnerCode: 156, cmdCode: '721012', netWgt: 1000, primaryValue: 900 }] }) }; };
  const waits = [];
  const r = await createHsTrade({ fetch: f, wait: ms => { waits.push(ms); return Promise.resolve(); }, now: () => new Date('2026-10-15T00:00:00Z') }).comtrade('MX', ['CN'], ['721012'], 'import', 12);
  assert.strictEqual(r.rows.length, 2);          // 1번째 달: 재시도 성공, 2번째 달 성공, 3번째 달 두 번 다 429 → 멈춤
  assert.ok(waits.includes(3000) && waits.includes(1200));
  assert.strictEqual(r.failed[0].status, '429');
});

test('키가 401로 거절되면 미리보기로 이어서 받는다', async () => {
  process.env.COMTRADE_API_KEY = 'bad-key';
  const f = async (url) => {
    if (url.includes('/data/v1/get')) return { ok: false, status: 401, text: async () => '{"statusCode":401}' };
    const per = new URL(url).searchParams.get('period');
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ period: per, partnerCode: 156, cmdCode: '721012', netWgt: 1000, primaryValue: 900 }] }) };
  };
  const r = await createHsTrade({ fetch: f, wait: () => Promise.resolve(), now: () => new Date('2026-10-15T00:00:00Z') }).comtrade('MX', ['CN'], ['721012'], 'import', 3);
  assert.deepStrictEqual([r.keyError, r.keyed, r.rows.length], ['401', false, 3]);
  delete process.env.COMTRADE_API_KEY;
});

test('분석 문장: 규모·점유율·흐름·단가 격차·코드 구성·교차 확인', () => {
  const { analyze, shape } = require('../lib/hstrade');
  const months = ['202601', '202602', '202603', '202604', '202605', '202606'];
  const rows = [];
  months.forEach((m, i) => {
    rows.push({ ym: m, code: '721012', partner: 'CN', kg: (i < 3 ? 2000 : 3000) * 1000, usd: (i < 3 ? 2000 : 3000) * 950 });
    rows.push({ ym: m, code: '721011', partner: 'CN', kg: 500000, usd: 500 * 1000 });
    rows.push({ ym: m, code: '721012', partner: 'KR', kg: 1000000, usd: 1000 * 1200 });
    rows.push({ ym: m, code: '721012', partner: 'WD', kg: 8000000, usd: 8000 * 1000 });
  });
  const out = { market: 'MX', marketName: '멕시코', codes: ['721011', '721012'], partners: [{ code: 'CN' }, { code: 'KR' }], main: shape(rows, ['CN', 'KR', 'WD'], ['721011', '721012']),
    koreaExport: shape(months.map(m => ({ ym: m, code: '721012', partner: 'KR', kg: 500000, usd: 500 * 1150 })), ['KR'], ['721012']) };
  const f = analyze(out), byK = k => f.find(x => x.kind === k).text;
  assert.ok(/48,000t \(연간 환산 약 96,000t\)/.test(byK('volume')));
  assert.ok(/중국산 18,000t\(37.5%\)/.test(byK('volume')));
  assert.ok(/중국산 물량 \+40%/.test(byK('trend')));
  assert.ok(/한국산이 중국산보다 톤당 \$\d+/.test(byK('price')));
  assert.ok(/721012 83%/.test(byK('mix')));
  assert.ok(/물량 차이 \+100%/.test(byK('cross')));
  const fx = k => f.find(x => x.kind === k).insight;
  assert.ok(/다른 나라를 거쳐/.test(fx('cross')) && /물량↑ → 수요 증가/.test(fx('trend')) && /장기계약/.test(fx('price')) && /정기 계약/.test(fx('pattern')));
});

test('시장 노트: 수입국·코드로 고르고, 관리자 저장값이 기본값을 덮어씀', async () => {
  const { createHsNotes, applies } = require('../lib/hsnotes');
  const { createKv } = require('../lib/kv');
  assert.ok(applies({ market: 'MX', codes: ['72'] }, 'MX', ['721012']));
  assert.ok(!applies({ market: 'MX', codes: ['72'] }, 'US', ['721012']));
  const n = createHsNotes({ kv: createKv() });
  assert.ok((await n.forQuery('MX', ['721012'])).length >= 2);
  await n.save([{ market: 'mx', codes: '7210, 7212', title: 'T', body: 'B', sources: [{ url: 'javascript:x' }, { title: 'ok', url: 'https://ex.com' }] }]);
  const r = await n.forQuery('MX', ['721210']);
  assert.deepStrictEqual([r.length, r[0].sources.length, r[0].market], [1, 1, 'MX']);
});

test('일부 달이 빠진 결과는 저장하지 않고, 다음 조회에서 다시 묻는다', async () => {
  process.env.COMTRADE_API_KEY = 'k';
  const { createKv } = require('../lib/kv');
  let full = 0;
  const f = async (url) => {
    if (!url.includes('comtrade')) return { ok: true, status: 200, text: async () => '<response><header><resultCode>00</resultCode></header><body><items></items></body></response>' };
    const per = new URL(url).searchParams.get('period');
    if (per.includes(',')) { full++; return { ok: false, status: 429, text: async () => 'rate' }; }
    if (per === '202606') return { ok: false, status: 500, text: async () => 'x' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ period: per, partnerCode: 156, cmdCode: '721012', netWgt: 1000, primaryValue: 900 }] }) };
  };
  const h = createHsTrade({ fetch: f, kv: createKv(), wait: () => Promise.resolve(), now: () => new Date('2026-10-15T00:00:00Z') });
  const a = await h.search({ codes: '721012', market: 'MX', partners: 'CN' });
  assert.deepStrictEqual([a.comtradeMeta.mode, a.comtradeMeta.failed.length, !!a.cache], ['perMonth', 1, false]);
  const b = await h.search({ codes: '721012', market: 'MX', partners: 'CN' });
  assert.ok(!b.cache && full === 2);
  delete process.env.COMTRADE_API_KEY;
});
