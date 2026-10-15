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
  assert.strictEqual((await call(h.probe, { headers: {} })).s, 503);
  process.env.FELIX_ADMIN_TOKEN = 'admintok';
  assert.strictEqual((await call(h.admin, { headers: { 'x-admin-token': 'nope' }, body: { action: 'get' } })).s, 401);
  assert.strictEqual((await call(h.admin, { headers: { 'x-admin-token': 'admintok' }, body: { action: 'get' } })).s, 200);
  assert.strictEqual((await call(h.probe, { headers: {} })).s, 401);
  assert.strictEqual((await call(h.admin, { headers: { 'x-admin-token': ' admintok ' }, body: { action: 'get' } })).s, 200); // 앞뒤 공백 무시
  process.env.CRON_SECRET = 'cs';
  assert.strictEqual((await call(h.cron, { headers: { authorization: 'Bearer x' } })).s, 401);
  assert.strictEqual((await call(h.cron, { headers: { authorization: 'Bearer cs' } })).b.ok, 'c');
  delete process.env.FELIX_ADMIN_TOKEN; delete process.env.CRON_SECRET;
});

test('API 없이: 숫자 초안, 요청문 복사, Claude 답 붙여넣기', async () => {
  const f = async (url) => { const s = require('../lib/report-data').SOURCES.find(x => url.endsWith(x.path)); return { ok: true, status: 200, json: async () => (s ? RAW[s.id] : {}) }; };
  const news = { collect: async () => ({ news: [{ id: 'n1', title: 'EU cuts steel quotas', url: 'https://ex.com/eu', source: 'ex.com', date: '2026-10-10' }], official: [{ id: 'o1', title: 'Certain Steel: Initiation', url: 'https://www.federalregister.gov/d/1', date: '2026-10-09', kind: 'official' }], errors: {} }) };
  const r = createReport({ fetch: f, kv: createKv(), news, ai: { pickModel: async () => { throw new Error('no'); } }, now: () => new Date('2026-10-13T01:00:00Z') });
  await r.collect('http://x');
  const a = await r.draftAuto();
  assert.ok(a.title.includes('%'));
  let d = (await r.adminGet()).draft;
  assert.ok(d.oneLiner.length > 0 && d.takeaways.length >= 2 && d.regions.length > 0);
  assert.deepStrictEqual(d.issues, []);
  const p = (await r.prompt()).prompt;
  assert.ok(p.includes('n1 | 2026-10-10 | ex.com | EU cuts steel quotas') && p.includes('o1 |') && p.includes('"issues"') && p.includes('"takeaways"') && p.includes('cn:hr'));
  const answer = '좋습니다. 아래가 결과입니다.\n```json\n' + JSON.stringify({ title: '새 제목', oneLiner: '한 줄', takeaways: ['a', 'b', 'c'], regions: [{ region: 'cn', text: '중국 설명' }],
    issues: [{ type: '무역정책', title: 'EU 쿼터 축소', what: 'w', path: 'p', impact: 'i', dir: '하락', items: ['hr'], regions: ['eu'], watch: 'w', watchKey: 'cn:hr', conf: '중간', confWhy: 'c', sources: ['n1'] }, { title: '출처 없음', sources: [] }],
    calendar: [{ date: '2026-10-20', title: '예비판정', why: 'y', sources: ['o1'] }], checks: [{ key: 'cn:hr', expect: 'down', label: '약세' }] }) + '\n```';
  const imp = await r.importAnswer(answer);
  assert.deepStrictEqual([imp.issues, imp.dropped, imp.calendar, imp.checks], [1, 1, 1, 1]);
  d = (await r.adminGet()).draft;
  assert.strictEqual(d.title, '새 제목');
  assert.strictEqual(d.issues[0].sources[0].url, 'https://ex.com/eu');
  await assert.rejects(r.importAnswer('죄송합니다'), e => e.code === 'bad_answer');
  assert.deepStrictEqual(await r.publish(), { no: 1, weekLabel: '2026년 10월 2주' });
});

test('자체 시계열: 같은 기간은 한 번, 직전 기간 보탬, 정정 반영', async () => {
  const { createHistory, merge, prevPeriodOf } = require('../lib/history');
  assert.strictEqual(prevPeriodOf('2026-10 상순'), '2026-09 하순');
  const kv = createKv(), h = createHistory({ kv, now: () => new Date('2026-10-14T01:00:00Z') });
  const rows = [{ key: 'cn:hr', regionName: '중국', label: '열연', unit: '위안/t', basis: 'b', value: 3266, prev: 3309, period: '2026-10 상순' }, { key: 'mx:plate', value: 900, period: '2026-08', low: true }];
  let r = await h.snapshot(rows);
  assert.deepStrictEqual([r.added, r.updated], [2, 0]);
  r = await h.snapshot(rows);
  assert.deepStrictEqual([r.added, r.updated], [0, 0]);
  rows[0] = Object.assign({}, rows[0], { value: 3240, prev: 3266, period: '2026-10 중순' });
  await h.snapshot(rows);
  const g = await createHistory({ kv }).get('cn:hr,mx:plate');
  assert.deepStrictEqual(g.series['cn:hr'].pts, [['2026-09 하순', 3309], ['2026-10 상순', 3266], ['2026-10 중순', 3240]]);
  assert.ok(!g.series['mx:plate']);
  assert.strictEqual(merge({}, [{ key: 'a', value: 1, period: '2026-08' }], 'x').store.a.pts.length, 1);
});

test('체감 투표: 기기당 주 1회, 잘못된 값 거절, 합계만', async () => {
  const { createVotes, weekId } = require('../lib/votes');
  assert.strictEqual(weekId(new Date('2026-10-14T01:00:00Z')), '2026-W42');
  const v = createVotes({ kv: createKv(), now: () => new Date('2026-10-14T01:00:00Z') });
  assert.strictEqual((await v.vote({ item: 'hr', dir: 'down', cid: 'abcdefgh1' })).counted, true);
  assert.strictEqual((await v.vote({ item: 'hr', dir: 'up', cid: 'abcdefgh1' })).counted, false);
  await v.vote({ item: 'hr', dir: 'up', cid: 'zzzzzzzz2' });
  assert.strictEqual((await v.vote({ item: 'xx', dir: 'up', cid: 'zzzzzzzz2' })).ok, false);
  assert.strictEqual((await v.vote({ item: 'hr', dir: 'up', cid: 'x' })).ok, false);
  const r = await v.results();
  assert.deepStrictEqual(r.items.hr, { up: 1, flat: 0, down: 1, n: 2 });
  assert.strictEqual(r.items.cr.n, 0);
});

test('뉴스: Google 뉴스 RSS 파싱과 GDELT 실패 시 대체', async () => {
  const { parseRss } = require('../lib/news');
  const xml = '<rss><channel><item><title>Nippon Steel to raise prices for January shipments - Reuters</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Tue, 14 Oct 2026 07:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item><item><title>&lt;b&gt;bad&lt;/b&gt;</title><link>javascript:x</link></item></channel></rss>';
  const r = parseRss(xml);
  assert.deepStrictEqual(r, [{ title: 'Nippon Steel to raise prices for January shipments', url: 'https://news.google.com/rss/articles/abc', source: 'Reuters', date: '2026-10-14' }]);
  const f = async (url) => url.includes('gdelt') ? { ok: false, status: 429, text: async () => 'rate' }
    : url.includes('news.google') ? { ok: true, status: 200, text: async () => xml } : { ok: true, status: 200, text: async () => JSON.stringify({ count: 0, results: [] }) };
  const n = await createNews({ fetch: f, wait: () => Promise.resolve() }).collect(7);
  assert.strictEqual(n.news.length, 1);
  assert.strictEqual(n.errors.counts.gnews, 1);
  assert.strictEqual(n.errors.gdelt[0].status, '429');
  const t = await createNews({ fetch: f, wait: () => Promise.resolve() }).topic(['tinplate (Mexico OR China) sourcelang:english', 'hojalata México sourcelang:spanish'], 90);
  assert.strictEqual(t.items.length, 1);
  assert.strictEqual(t.items[0].lang, 'English');
});

test('패널 관심 등록: 휴대폰만 필수, 같은 번호는 갱신, 동의 필수', async () => {
  const { createPanel, phoneOf } = require('../lib/panel');
  assert.deepStrictEqual([phoneOf('010-1234-5678'), phoneOf('+82 10 1234 5678'), phoneOf('02-123-4567'), phoneOf('0101234')], ['01012345678', '01012345678', null, null]);
  const p = createPanel({ kv: createKv(), now: () => new Date('2026-10-15T00:00:00Z') });
  assert.strictEqual((await p.register({ phone: '02-123-4567', consent: true })).error, 'phone');
  assert.strictEqual((await p.register({ phone: '010-1234-5678' })).error, 'consent');
  assert.deepStrictEqual(await p.register({ phone: '010-1234-5678', items: ['hr', 'xx'], consent: true }), { ok: true, updated: false });
  assert.deepStrictEqual(await p.register({ phone: '01012345678', company: 'A철강<b>', role: '유통', consent: true }), { ok: true, updated: true });
  const l = await p.list();
  assert.strictEqual(l.count, 1);
  assert.deepStrictEqual([l.items[0].phone, l.items[0].company, l.items[0].role, l.items[0].items], ['010-1234-5678', 'A철강b', '유통', ['hr']]);
});
