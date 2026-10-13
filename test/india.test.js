'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readSheet } = require('../lib/xlsx-lite');
const { analyze, pick, findLink, monthOf, createIndia } = require('../lib/india');
const X = fs.readFileSync(path.join(__dirname, 'fixtures', 'in-wpi-mini.xlsx'));

test('월 머리글 해석', () => {
  assert.strictEqual(monthOf('INDX092026'), '2026-09');
  assert.strictEqual(monthOf('Sep-26'), '2026-09');
  assert.strictEqual(monthOf('2026-09'), '2026-09');
  assert.strictEqual(monthOf('COMM_NAME'), null);
});

test('다운로드 페이지에서 가장 최근 월 파일', () => {
  const html = '<a href="indx_download_2223/wpi_monthly_index_202608.xlsx">x</a><a href="https://eaindustry.nic.in/indx_download_2223/wpi_monthly_index_202609.xlsx">y</a>';
  assert.strictEqual(findLink(html), 'https://eaindustry.nic.in/indx_download_2223/wpi_monthly_index_202609.xlsx');
});

test('표 분석과 품목 고르기', () => {
  const a = analyze(readSheet(X, null));
  assert.strictEqual(a.headerRow, 2);
  const p = pick(a.items);
  assert.deepStrictEqual([p.hr.name, p.hr.period, p.hr.value, p.hr.prev], ['HR coils & sheets, including narrow strip', '2026-09', 100.2, 100.8]);
  assert.strictEqual(p.cr.value, 102.9);
  assert.strictEqual(p.coated.name, 'GP/GC sheets');
  assert.strictEqual(p.wire_rod.name, 'MS wire rods');
  assert.strictEqual(p.rebar.name, 'Bars & rods');
  assert.strictEqual(p.pipe.name, 'Pipes & tubes');
  assert.strictEqual(p.sts.value, 96.1);
  assert.strictEqual(p.iron_ore.value, 99);
  assert.strictEqual(p.coking_coal.value, 108);
  assert.strictEqual(p.al.name, 'Aluminium ingot');
  assert.strictEqual(p.plate, undefined);
});

test('서비스: 페이지 → 파일 → 결과', async () => {
  const f = async (url) => url.endsWith('.asp')
    ? { ok: true, status: 200, text: async () => '<a href="indx_download_2223/wpi_monthly_index_202609.xlsx">WPI</a>' }
    : { ok: true, status: 200, arrayBuffer: async () => X };
  const r = await createIndia({ fetch: f, log: () => {} }).latest();
  assert.strictEqual(r.period, '2026-09');
  assert.ok(r.fileUrl.endsWith('wpi_monthly_index_202609.xlsx'));
});
