'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TOK = 'INEGI_FAKE_TOKEN_DO_NOT_LEAK';
process.env.INEGI_TOKEN = TOK;
const { createInegi } = require('../lib/inegi');

test('진단: 토큰 확인과 지표 목록 필터, 토큰 비노출', async () => {
  const urls = [];
  const f = async (url) => {
    urls.push(url);
    const body = url.includes('/INDICATOR/') ? { Series: [{ INDICADOR: '1002000001' }] }
      : { CODE: [{ value: '910407', Description: 'Varilla corrugada' }, { value: '1', Description: 'Población total' }, { value: '910410', Description: 'Lámina rolada en caliente ' + TOK }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const r = await createInegi({ fetch: f }).probe();
  assert.strictEqual(r.tokenOk, true);
  assert.strictEqual(r.catalogSize, 3);
  assert.strictEqual(r.matches.length, 2);
  assert.ok(urls.every(u => u.includes(TOK)));
  assert.ok(!JSON.stringify(r).includes(TOK));
});
