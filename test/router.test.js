'use strict';
const test = require('node:test');
const assert = require('node:assert');
delete process.env.BLS_API_KEY;
delete process.env.CENSUS_API_KEY;
const router = require('../api/router');
const { routeName } = require('../lib/routes');

function call(url) {
  return new Promise(resolve => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(b) }); } };
    router({ url, method: 'GET' }, res);
  });
}

test('경로 이름 정리', () => {
  assert.strictEqual(routeName('/api/us-ppi'), 'us-ppi');
  assert.strictEqual(routeName('us-ppi-probe'), 'us-ppi-probe');
});

test('rewrite된 요청(?route=)과 원래 경로 둘 다 처리, 없는 경로는 404', async () => {
  const a = await call('/api/router?route=us-ppi');
  assert.strictEqual(a.status, 503);                       // 키 없음 안내(404 아님)
  assert.strictEqual(a.body.error, 'not_configured');
  const b = await call('/api/us-ppi-probe');
  assert.strictEqual(b.status, 503);
  const c = await call('/api/router?route=nope');
  assert.strictEqual(c.status, 404);
  const d = await call('/api/router?route=us-state-imports&state=TX');
  assert.strictEqual(d.status, 503);                       // Census 키 없음
  assert.strictEqual(d.headers['Cache-Control'], 'no-store');
});
