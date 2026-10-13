'use strict';
const test = require('node:test');
const assert = require('node:assert');
delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
const { normalize, analyze, releaseCalendar } = require('../lib/report-data');
const { createNews, dedupe } = require('../lib/news');
const { createReport, makeReportHandlers, gradeChecks, weekLabel } = require('../lib/report');
const { cleanIssues, cleanSummary, createAi } = require('../lib/report-ai');
const { createKv } = require('../lib/kv');

// 앱 API 응답 견본
const RAW = {
  cn: { status: 'ok', period: { year: 2026, month: 10, part: '上旬' }, items: { cn4: { price: 3300, prev: 3350 }, cn1: { price: 3200, prev: 3180 }, cn7: { price: 1200, prev: 1100 }, cn8: { price: 1800, prev: 1700 } } },
  krPpi: { items: [{ id: 'kr3', status: 'ok', value: 120, prev: 121, period: '2026-08' }] },
  krTrade: { month: '2026-08', items: [{ id: 'imp1', status: 'ok', unitPrice: 560, tons: 100000, prev: { status: 'ok', unitPrice: 580 } }, { id: 'sd1', status: 'ok', unitPrice: 600, tons: 700000, prev: { status: 'ok', tons: 650000 } }] },
  usPpi: { items: [{ id: 'gl1', status: 'ok', value: 300, prev: 297, period: '2026-08' }] },
  world: { items: { iron_ore: { value: 100, prev: 104, period: '2026-09' } } },
  india: { items: { hr: { value: 140, prev: 141, period: '2026-09' } } },
  mx: { month: '2026-08', items: { hr: { status: 'ok', unitPrice: 680, prev: { unitPrice: 690 } }, plate: { status: 'ok', unitPrice: 900, lowVolume: true, prev: null } } },
  jp: { items: [{ id: 'hr', status: 'ok', month: '2026-08', flow: 'export', unitPriceJpy: 90000, prev: { status: 'ok', unitPriceJpy: 92000 } }] },
  eu: { items: { hr: { comext: { status: 'ok', unitPrice: 606, period: '2026-07', prev: { unitPrice: 596 } }, ppi: null }, coke: { comext: { status: 'nodata' }, ppi: { nace: 'C191', value: 110, prev: 100, period: '2026-08' } } } },
  fx: { rates: { USD: 1400 }, prevRates: { USD: 1390 }, date: '2026-10-13' }
};

test('정규화·분석: 시장가·지수만 순위, 수입 단가·물량 적음 제외, 국가 차트', () => {
  const { rows, status } = normalize(RAW);
  assert.strictEqual(status.cn, 'ok:4');
  assert.ok(rows.find(r => r.key === 'krimp:hr' && r.kind === 'unit'));
  const a = analyze(rows);
  assert.ok(a.movers.up.every(r => r.kind !== 'unit'));
  assert.strictEqual(a.movers.up[0].key, 'eu:coke');              // +10% (PPI 보완)
  assert.ok(a.movers.down.some(r => r.key === 'world:iron_ore'));
  assert.deepStrictEqual(a.chart.find(c => c.region === 'eu').pct, 1.68);
  assert.strictEqual(a.regions.find(g => g.region === 'kr').rows[0].kind, 'index'); // 한국은 물가지수 우선
  assert.strictEqual(a.cnSupply.value, 700000);
  assert.strictEqual(a.fx.pct, 0.72);
});

test('발표 일정과 주차 표기', () => {
  const c = releaseCalendar(new Date('2026-10-13T00:00:00Z'));
  assert.ok(c.find(x => x.date === '2026-10-14' && /중국/.test(x.title)));
  assert.ok(c.find(x => x.date === '2026-10-15' && /관세청/.test(x.title)));
  assert.strictEqual(weekLabel('2026-10-15'), '2026년 10월 3주');
});

test('뉴스: 비슷한 제목 묶기, http(s) 링크만, 5초 간격', async () => {
  assert.strictEqual(dedupe([{ title: 'EU extends steel safeguard measures to 2027' }, { title: 'EU extends steel safeguard measures until 2027' }, { title: 'China crude steel output falls' }]).length, 2);
  const waits = [];
  const f = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.includes('gdelt')
    ? { articles: [{ url: 'https://ex.com/a', title: 'US raises Section 232 steel tariffs', seendate: '20261012T010000Z', domain: 'ex.com' }, { url: 'javascript:alert(1)', title: 'bad' }] }
    : { count: 1, results: [{ title: 'Certain Steel: Initiation of Antidumping Investigation', html_url: 'https://www.federalregister.gov/d/1', publication_date: '2026-10-10' }] }) });
  const n = await createNews({ fetch: f, wait: ms => { waits.push(ms); return Promise.resolve(); } }).collect(7);
  assert.deepStrictEqual(waits, [5500, 5500]);
  assert.strictEqual(n.news.length, 1);              // 3개 질의가 같은 기사 → 하나로, 위험한 링크 제외
  assert.strictEqual(n.news[0].id, 'n1');
  assert.strictEqual(n.official[0].id, 'o1');
});

test('AI 결과 정리: 모르는 출처·키 버림, 출처 없는 이슈 제외', () => {
  const inp = { news: { news: [{ id: 'n1', title: 'T', url: 'https://ex.com/a', source: 'ex.com' }], official: [] }, rows: normalize(RAW).rows, analysis: analyze(normalize(RAW).rows) };
  const r = cleanIssues({ issues: [{ type: '무역정책', title: 'A', dir: '하락', items: ['hr', 'xx'], sources: ['n1', 'n9'], watchKey: 'cn:hr' }, { title: 'B', sources: ['n9'] }], calendar: [{ date: '2026-10-20', title: 'C' }, { date: '언젠가', title: 'D' }] }, inp);
  assert.strictEqual(r.issues.length, 1);
  assert.deepStrictEqual(r.issues[0].items, ['hr']);
  assert.strictEqual(r.issues[0].sources[0].url, 'https://ex.com/a');
  assert.strictEqual(r.calendar.length, 1);
  const s = cleanSummary({ title: 'X', regions: [{ region: 'cn', text: 'a' }, { region: 'zz', text: 'b' }], checks: [{ key: 'cn:hr', expect: 'down', label: 'L' }, { key: 'mx:plate', expect: 'up', label: 'low' }] }, inp);
  assert.strictEqual(s.regions.length, 1);
  assert.strictEqual(s.checks.length, 1);            // 물량 적은 항목은 전망 대상 아님
});

test('AI: 모델 자동 선택(sonnet), 키는 헤더로만', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret'; delete process.env.ANTHROPIC_MODEL;
  const seen = [];
  const f = async (url, o) => { seen.push({ url, o }); return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('/models') ? { data: [{ id: 'claude-opus-x' }, { id: 'claude-sonnet-x' }] } : { content: [{ type: 'text', text: '{"issues":[],"calendar":[]}' }] }) }; };
  const ai = createAi({ fetch: f });
  assert.strictEqual(await ai.pickModel(), 'claude-sonnet-x');
  await ai.issues({ today: '2026-10-13', rows: [], news: { news: [], official: [] } });
  assert.ok(seen.every(x => !x.url.includes('sk-test-secret')));
  assert.strictEqual(JSON.parse(seen[1].o.body).model, 'claude-sonnet-x');
  delete process.env.ANTHROPIC_API_KEY;
});

test('전망 채점: 같은 기간이면 대기, 새 값이면 맞음/틀림', () => {
  const rows = [{ key: 'cn:hr', value: 3250, period: '10 중순' }, { key: 'cn:rebar', value: 3300, period: '10 상순' }];
  const g = gradeChecks([{ key: 'cn:hr', expect: 'down', baseValue: 3300, basePeriod: '10 상순' }, { key: 'cn:rebar', expect: 'up', baseValue: 3300, basePeriod: '10 상순' }, { key: 'x', expect: 'up' }], rows);
  assert.deepStrictEqual(g.map(x => x.result), ['hit', 'pending', 'nodata']);
});

function fakeAi() {
  return {
    pickModel: async () => 'm',
    issues: async inp => ({ issues: [{ id: 'i1', type: '무역정책', title: '미국 232조', what: 'w', path: 'p', impact: 'i', dir: '하락', items: ['hr'], regions: ['us'], watch: 'w', watchKey: 'cn:hr', conf: '중간', confWhy: 'c', sources: [{ title: 'T', url: 'https://ex.com', source: 'ex.com' }] }], calendar: [{ date: '2026-10-20', title: '판정', why: 'y', sources: [] }], model: 'm' }),
    summary: async () => ({ title: '중국 열연 약세', oneLiner: 'o', takeaways: ['a', 'b', 'c'], regions: [{ region: 'cn', text: 't' }], checks: [{ key: 'cn:hr', expect: 'down', label: 'L' }], model: 'm' })
  };
}

test('흐름: 수집 → 초안 2단계 → 수정 저장 → 발행 → 공개 조회 → 다음 호 채점', async () => {
  const f = async (url) => {
    const s = require('../lib/report-data').SOURCES.find(x => url.endsWith(x.path));
    return { ok: true, status: 200, json: async () => (s ? RAW[s.id] : {}) };
  };
  const news = { collect: async () => ({ news: [{ id: 'n1', title: 'T', url: 'https://ex.com' }], official: [], errors: {} }) };
  const kv = createKv();
  const r = createReport({ fetch: f, kv, news, ai: fakeAi(), now: () => new Date('2026-10-13T01:00:00Z') });
  const c = await r.collect('http://x');
  assert.strictEqual(c.today, '2026-10-13');
  assert.ok(c.rows > 10);
  await r.draftIssues(); await r.draftSummary();
  const d = await r.save(Object.assign({}, (await r.adminGet()).draft, { title: '대표가 고친 제목', takeaways: ['x'] }));
  assert.strictEqual(d.title, '대표가 고친 제목');
  const p = await r.publish();
  assert.deepStrictEqual(p, { no: 1, weekLabel: '2026년 10월 2주' });
  const pub = await r.publicGet();
  assert.strictEqual(pub.issue.title, '대표가 고친 제목');
  assert.strictEqual(pub.issue.checks[0].baseValue, 3300);
  assert.ok(pub.issue.calendar.some(x => x.kind === 'release') && pub.issue.calendar.some(x => x.kind === 'event'));
  assert.ok(pub.issue.analysis.movers);
  // 다음 주: 중국 열연이 새 기간에 내림 → 맞음
  RAW.cn = Object.assign({}, RAW.cn, { period: { year: 2026, month: 10, part: '中旬' }, items: Object.assign({}, RAW.cn.items, { cn4: { price: 3250, prev: 3300 } }) });
  await r.collect('http://x');
  const g = await r.adminGet();
  assert.strictEqual(g.inputs.pastCheck.checks[0].result, 'hit');
  assert.strictEqual(g.nextNo, 2);
});

test('관리자 인증: 토큰 없거나 틀리면 거절, 크론은 CRON_SECRET', async () => {
  const h = makeReportHandlers({ adminGet: async () => ({ ok: 1 }), collect: async () => ({ ok: 'c' }), probe: async () => ({}) }, () => {});
  const call = (fn, ctx) => new Promise(res => fn({}, (s, b) => res({ s, b }), ctx));
  delete process.env.FELIX_ADMIN_TOKEN;
  assert.strictEqual((await call(h.admin, { headers: {}, body: { action: 'get' } })).s, 503);
  process.env.FELIX_ADMIN_TOKEN = 'admintok';
  assert.strictEqual((await call(h.admin, { headers: { 'x-admin-token': 'nope' }, body: { action: 'get' } })).s, 401);
  assert.strictEqual((await call(h.admin, { headers: { 'x-admin-token': 'admintok' }, body: { action: 'get' } })).s, 200);
  assert.strictEqual((await call(h.probe, { headers: {} })).s, 401);
  process.env.CRON_SECRET = 'cs';
  assert.strictEqual((await call(h.cron, { headers: { authorization: 'Bearer x' } })).s, 401);
  assert.strictEqual((await call(h.cron, { headers: { authorization: 'Bearer cs' } })).b.ok, 'c');
  delete process.env.FELIX_ADMIN_TOKEN; delete process.env.CRON_SECRET;
});
