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
  assert.strictEqual(monthOf('Aug-26'), '2026-08');
  assert.strictEqual(monthOf('Commodity Name'), null);
});

test('다운로드 페이지에서 가장 최근 월 파일', () => {
  const html = '<a href="indx_download_2223/wpi_monthly_index_202608.xlsx">x</a><a href="https://eaindustry.nic.in/indx_download_2223/wpi_monthly_index_202609.xlsx">y</a>';
  assert.strictEqual(findLink(html), 'https://eaindustry.nic.in/indx_download_2223/wpi_monthly_index_202609.xlsx');
});

test('코드 범위 안에서만 품목을 고른다 (실제 파일 구조, 10/13 진단의 오매칭 사례 포함)', () => {
  const a = analyze(readSheet(X, null));
  const p = pick(a.items);
  const n = k => p[k] && p[k].name;
  assert.strictEqual(n('hr'), 'Hot Rolled Steel Coils/Sheets/Strips');
  assert.deepStrictEqual([p.hr.period, p.hr.value, p.hr.prev], ['2026-08', 87.9, 92.4]);
  assert.strictEqual(n('wire_rod'), 'MS Wire Rods');           // 구리 선재 아님
  assert.strictEqual(n('section'), 'Angles, Channels, Sections'); // 유리 팔찌 아님
  assert.strictEqual(n('pipe'), 'Pipes, tubes & casing of steel/iron');   // PVC·황동관 아님
  assert.strictEqual(p.pipe.by, 'code');
  assert.strictEqual(n('coke'), undefined);                     // 석유 코크스 아님
  assert.strictEqual(n('al'), 'Aluminium ingot');              // 호일 아님 (코드가 다르면 이름 규칙으로)
  assert.strictEqual(n('zn'), 'Non-Alloyed Zinc');             // 정광 아님
  assert.strictEqual(n('pb'), 'Refined Lead');                 // 연필 아님
  assert.strictEqual(n('cu'), 'Copper cathodes and sections of cathodes');
  assert.strictEqual(n('rebar'), 'Bars and Rods of Mild steel');
  assert.strictEqual(n('scrap'), 'Scrap Iron/Steel');
  assert.strictEqual(n('coking_coal'), 'Coking Coal');
});

test('서비스: 페이지 → 파일 → 결과', async () => {
  const f = async (url) => url.endsWith('.asp')
    ? { ok: true, status: 200, text: async () => '<a href="indx_download_2223/wpi_monthly_index_202609.xlsx">WPI</a>' }
    : { ok: true, status: 200, arrayBuffer: async () => X };
  const r = await createIndia({ fetch: f, log: () => {} }).latest();
  assert.strictEqual(r.period, '2026-08');
  assert.ok(r.fileUrl.endsWith('wpi_monthly_index_202609.xlsx'));
});
