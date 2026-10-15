'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compute, logSignals, grade } = require('../lib/signal');
const { cleanMills } = require('../lib/report-ai');

const rows = [
  { key: 'world:iron_ore', pct: 4 }, { key: 'cn:coking_coal', pct: 3.2 }, { key: 'cn:coke', pct: 2.8 }, { key: 'us:scrap', pct: -3.5 },
  { key: 'cn:hr', pct: -1.3 }, { key: 'cn:rebar', pct: -0.9 }, { key: 'mx:plate', pct: 9, low: true }
];
const report = {
  mills: [{ maker: '일본제철', region: 'jp', items: ['hr', 'cr', 'coated'], action: '인상', effective: '2027-01 선적', date: '2026-10-15' },
          { maker: 'JFE', region: 'jp', items: ['hr'], action: '인상', date: '2026-10-14' }, { maker: '옛 발표', region: 'jp', items: ['hr'], action: '인하', date: '2026-06-01' }],
  issues: [{ title: '일본 고로 1월 인상', items: ['hr'], dir: '상승', conf: '높음' }, { title: '중국 수출 증가', items: ['hr', 'rebar'], dir: '하락', conf: '중간' }]
};
const votes = { minN: 5, items: { hr: { up: 12, flat: 4, down: 4, n: 20 }, rb: { up: 1, flat: 1, down: 1, n: 3 } } };

test('방향 신호: 요소 합산, 오래된 발표 제외, 물량 적은 값 무시, 확실성', () => {
  const s = compute({ rows, report, votes, today: '2026-10-15' });
  const hr = s.find(x => x.id === 'hr');
  assert.deepStrictEqual(hr.comps.map(c => c.id), ['cost', 'china', 'mills', 'issues', 'votes']);
  assert.strictEqual(hr.comps.find(c => c.id === 'mills').score, 2);        // 60일 넘은 '인하'는 빠짐
  assert.ok(/일본제철 인상\(2027-01 선적\)/.test(hr.comps.find(c => c.id === 'mills').text));
  assert.strictEqual(hr.dir, '상승');
  assert.strictEqual(hr.comps.reduce((a, c) => a + c.weight, 0) >= 99, true);
  const rebar = s.find(x => x.id === 'rebar');
  assert.ok(!rebar.comps.some(c => c.id === 'votes'));                       // 3명은 공개 기준 미달
  assert.ok(/고철 비중/.test(rebar.comps[0].text));
  assert.strictEqual(s.find(x => x.id === 'plate').comps.some(c => c.id === 'china'), false); // cn:plate 없음
  assert.strictEqual(compute({ rows: [], today: '2026-10-15' })[0].dir, null);
});

test('자체 시계열 3개 이상이면 3개 전 대비 흐름을 쓴다', () => {
  const hist = { 'cn:hr': { pts: [['a', 100], ['b', 104], ['c', 110]] } };
  const hr = compute({ rows, hist, today: '2026-10-15' }).find(x => x.id === 'hr');
  assert.ok(/▲10% \(최근 3회\)/.test(hr.comps.find(c => c.id === 'china').text));
});

test('신호 기록은 품목별 7일 간격, 2개월 뒤 국내 물가로 채점', () => {
  const hist = { 'kr:hr': { pts: [['2026-06', 100], ['2026-07', 101], ['2026-08', 102], ['2026-09', 103]] } };
  const sig = [{ id: 'hr', dir: '상승', score: 0.8, conf: '중간', ref: 'kr:hr' }];
  let log = logSignals([], sig, { 'kr:hr': { pts: [['2026-06', 100]] } }, '2026-07-01');
  log = logSignals(log, sig, hist, '2026-07-03');
  assert.strictEqual(log.length, 1);
  log = logSignals(log, [{ id: 'hr', dir: '하락', score: -0.5, ref: 'kr:hr' }], { 'kr:hr': { pts: [['2026-07', 101]] } }, '2026-07-09');
  const g = grade(log, hist);
  assert.deepStrictEqual([g.graded, g.hits, g.rate], [2, 1, 50]);            // 6월→8월 +2% 상승 맞음, 7월→9월 +2% 하락 틀림
  assert.strictEqual(g.per.hr.graded, 2);
});

test('제철소 발표 정리: 출처·품목·행동 없으면 버림', () => {
  const src = ids => (ids || []).filter(i => i === 'n1').map(() => ({ url: 'https://ex.com' }));
  const m = cleanMills([{ maker: '일본제철', region: 'jp', items: ['hr', 'xx'], action: '인상', sources: ['n1'] }, { maker: 'X', items: ['hr'], action: '올림', sources: ['n1'] }, { maker: 'Y', items: ['hr'], action: '인하', sources: ['n9'] }], src);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual(m[0].items, ['hr']);
});

test('평소 변동폭 대비 환산: 같은 1%라도 열흘 유통가는 크게, 철광석은 작게', () => {
  const { volOf, levelOf } = require('../lib/signal');
  const a = compute({ rows: [{ key: 'cn:hr', pct: 1.5 }], today: '2026-10-15' }).find(x => x.id === 'hr');
  assert.strictEqual(a.comps.find(c => c.id === 'china').score, 1);           // 사전 변동폭 1.5% → 평소만큼 = 1
  const b = compute({ rows: [{ key: 'world:iron_ore', pct: 1.5 }], today: '2026-10-15' }).find(x => x.id === 'hr');
  assert.ok(b.comps[0].score < 0.35 && /평소보다 작음/.test(b.comps[0].text));
  // 자체 시계열이 쌓이면 실제 변동폭 쪽으로 이동
  const pts = []; for (let i = 0; i < 20; i++) pts.push(['p' + String(i).padStart(2, '0'), 100 + (i % 2 ? 0.3 : 0)]);
  const v = volOf('cn:hr', 1, { 'cn:hr': { pts } });
  assert.ok(v.vol < 1 && v.n === 19);
  assert.deepStrictEqual([levelOf(1.2, 3).level, levelOf(0.5, 3).level, levelOf(0.2, 3).lean, levelOf(-0.1, 3).lean, levelOf(-0.6, 3).level, levelOf(0, 0).level], ['강한 상승', '상승 우위', 'up', null, '하락 우위', null]);
});
