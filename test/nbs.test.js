'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createNbs, parseRelease, findLinks } = require('../lib/nbs');
const RELEASE = fs.readFileSync(path.join(__dirname, 'fixtures', 'nbs-release.html'), 'utf8');
const LIST = '<ul><li><a href="./202610/t20261008_1965465.html" title="2026年9月下旬流通领域重要生产资料市场价格变动情况">2026年9月下旬流通领域重要生产资料市场价格变动情况</a><span>2026-10-09</span></li>'
  + '<li><a href="./202609/t20260930_1.html">2026年9月份国民经济运行情况</a></li>'
  + '<li><a href="./202609/t20260923_1965403.html">2026年9月中旬流通领域重要生产资料市场价格变动情况</a></li></ul>';

test('목록: 해당 발표 링크만 최신순, 상대 경로 해석', () => {
  const l = findLinks(LIST, 'https://www.stats.gov.cn/sj/zxfb/');
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].url, 'https://www.stats.gov.cn/sj/zxfb/202610/t20261008_1965465.html');
});

test('본문: 기간과 12개 품목, 전기 가격 역산', () => {
  const r = parseRelease(RELEASE);
  assert.deepStrictEqual(r.period, { year: 2026, month: 9, part: '下旬', label: '2026年9月下旬' });
  assert.strictEqual(Object.keys(r.items).length, 12);
  assert.deepStrictEqual([r.items.cn1.price, r.items.cn1.change, r.items.cn1.prev], [3175.9, 10.8, 3165.1]);
  assert.strictEqual(r.items.cn4.prev, 3308.9);                 // 앱에 수기로 넣었던 9월 중순 값과 같아야 한다
  assert.strictEqual(r.items.cn7.price, 2470);
  assert.strictEqual(r.items.cu.changePct, 2.7);
});

test('서비스: 첫 목록에서 못 찾으면 다음 목록, 캐시', async () => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const body = url.endsWith('/zxfb/') ? '<a href="x.html">다른 자료</a>' : url.includes('index_1') ? LIST : RELEASE;
    return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => Buffer.from(body) };
  };
  const svc = createNbs({ fetch: f, log: () => {} });
  const r = await svc.latest();
  assert.strictEqual(r.period.label, '2026年9月下旬');
  assert.strictEqual(r.url, 'https://www.stats.gov.cn/sj/zxfb/202610/t20261008_1965465.html');
  const n = calls.length;
  await svc.latest();
  assert.strictEqual(calls.length, n);
});
