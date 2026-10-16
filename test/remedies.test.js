'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRemedies, shape } = require('../lib/remedies');

test('무역 규제: 제목에서 단계·품목·대상국, DATES에서 앞으로의 기한', async () => {
  const a = shape({ title: 'Certain Corrosion-Resistant Steel Products From the Republic of Korea: Preliminary Results and Rescission, in Part, of Antidumping Duty Administrative Review; 2024-2025', html_url: 'https://www.federalregister.gov/d/1', publication_date: '2026-10-08', dates: 'Applicable October 8, 2026. Comments due November 7, 2026.', document_number: '1' }, '2026-10-16');
  assert.deepStrictEqual([a.stage, a.productKo, a.countriesKo, a.korea], ['prelim', '도금강판', ['한국'], true]);
  assert.deepStrictEqual(a.deadlines, [{ date: '2026-11-07', what: '의견 제출 마감' }]);
  const b = shape({ title: 'Certain Cut-to-Length Carbon Steel Plate From the People\'s Republic of China and the Russian Federation: Final Results of the Expedited Fifth Sunset Reviews of the Antidumping Duty Orders', html_url: 'https://x/2', publication_date: '2026-10-05' }, '2026-10-16');
  assert.deepStrictEqual([b.productKo, b.countriesKo, b.korea], ['후판', ['중국', '러시아'], false]);
  assert.strictEqual(b.stage, 'final');
  const c = shape({ title: 'Truck Bed Covers From the People\'s Republic of China: Preliminary Affirmative Determination of Sales at Less Than Fair Value, Postponement of Final Determination', html_url: 'https://x/3', publication_date: '2026-10-01', dates: 'The final determination will be issued no later than February 12, 2027.' }, '2026-10-16');
  assert.deepStrictEqual(c.deadlines, [{ date: '2027-02-12', what: '최종 판정 예정' }]);
  const f = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: [
    { title: 'Initiation of Antidumping and Countervailing Duty Administrative Reviews', html_url: 'https://x/0', publication_date: '2026-10-01' },
    { title: 'Certain Steel Nails From the Republic of Korea: Preliminary Results of Antidumping Duty Administrative Review', html_url: 'https://x/4', publication_date: '2026-10-08', comments_close_on: '2026-11-09' }] }) });
  const r = await createRemedies({ fetch: f, now: () => new Date('2026-10-16T00:00:00Z') }).get();
  assert.strictEqual(r.items.length, 1);                 // 연례 재심 일괄 공지는 뺀다
  assert.deepStrictEqual(r.upcoming.map(u => [u.date, u.what, u.productKo]), [['2026-11-09', '의견 제출 마감', '못']]);
});

test('DART: 회사 고유번호 찾기, 공급 관련 공시만, 키 없으면 건너뜀', async () => {
  const { createDart, parseCorpXml } = require('../lib/dart');
  const xml = '<result><list><corp_code>00000001</corp_code><corp_name>현대제철</corp_name><stock_code>004020</stock_code></list><list><corp_code>00000009</corp_code><corp_name>현대제철</corp_name><stock_code> </stock_code></list><list><corp_code>00000002</corp_code><corp_name>삼성전자</corp_name><stock_code>005930</stock_code></list></result>';
  assert.deepStrictEqual(parseCorpXml(xml, ['현대제철', '포스코홀딩스']), { '현대제철': '00000001' });
  delete process.env.DART_API_KEY;
  assert.strictEqual((await createDart({ fetch: async () => { throw new Error('no'); } }).recent(14)).status, 'not_configured');
  process.env.DART_API_KEY = 'test-key';
  const zlib = require('zlib');
  // CORPCODE.xml 하나를 담은 최소 zip
  const data = Buffer.from(xml), comp = zlib.deflateRawSync(data), name = Buffer.from('CORPCODE.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const cdOff = 30 + name.length + comp.length, eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
  const zip = Buffer.concat([local, name, comp, cen, name, eocd]);
  const f = async (url) => url.includes('corpCode') ? { ok: true, arrayBuffer: async () => zip } : { ok: true, json: async () => ({ status: '000', list: [{ report_nm: '주요사항보고서(생산중단)', rcept_no: '20261015000123', rcept_dt: '20261015' }, { report_nm: '임원ㆍ주요주주특정증권등소유상황보고서', rcept_no: '2', rcept_dt: '20261014' }] }) };
  const r = await createDart({ fetch: f, now: () => new Date('2026-10-16T00:00:00Z') }).recent(14);
  assert.strictEqual(r.items.length, 1);
  assert.deepStrictEqual([r.items[0].title, r.items[0].date, r.items[0].url], ['현대제철 · 주요사항보고서(생산중단)', '2026-10-15', 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261015000123']);
  delete process.env.DART_API_KEY;
});
