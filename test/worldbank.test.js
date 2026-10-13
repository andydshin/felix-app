'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readSheet } = require('../lib/xlsx-lite');
const { createWorldBank, parseMonthly, findXlsxLink } = require('../lib/worldbank');
const XLSX = fs.readFileSync(path.join(__dirname, 'fixtures', 'wb-mini.xlsx'));

test('xlsx 읽기: 시트 이름으로 찾고 셀 값을 돌려준다', () => {
  const rows = readSheet(XLSX, 'Monthly Prices');
  assert.strictEqual(rows[4][4], 'Iron ore, cfr spot');
  assert.strictEqual(rows[8][0], '2026M08');
  assert.strictEqual(rows[8][4], 96.3);
});

test('월간 표 해석: 최신 월·전월, 빈 칸은 건너뜀', () => {
  const it = parseMonthly(readSheet(XLSX, 'Monthly Prices'));
  assert.deepStrictEqual([it.iron_ore.period, it.iron_ore.value, it.iron_ore.prev], ['2026-08', 96.3, 98.2]);
  assert.strictEqual(it.coal_au.value, 135.2);
  assert.strictEqual(it.al.prev, 3161);
  assert.strictEqual(it.pb.value, 2010);
  assert.strictEqual(it.iron_ore.unit, '($/dmtu)');
});

test('안내 페이지에서 파일 링크 찾기, 실패하면 마지막 확인 주소', async () => {
  assert.strictEqual(findXlsxLink('<a href="https://thedocs.worldbank.org/en/doc/abc-0050012026/related/CMO-Historical-Data-Monthly.xlsx">Monthly</a>'), 'https://thedocs.worldbank.org/en/doc/abc-0050012026/related/CMO-Historical-Data-Monthly.xlsx');
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (url.includes('commodity-markets')) return { ok: false, status: 403 };
    return { ok: true, status: 200, arrayBuffer: async () => XLSX };
  };
  const r = await createWorldBank({ fetch: f, log: () => {} }).latest();
  assert.strictEqual(r.period, '2026-08');
  assert.ok(calls[1].includes('CMO-Historical-Data-Monthly.xlsx'));
});
