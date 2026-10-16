'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRemedies, shape } = require('../lib/remedies');

test('무역 규제: 제목에서 단계·품목·대상국, DATES에서 앞으로의 기한', async () => {
  const a = shape({ title: 'Certain Corrosion-Resistant Steel Products From the Republic of Korea: Preliminary Results and Rescission, in Part, of Antidumping Duty Administrative Review; 2024-2025', html_url: 'https://www.federalregister.gov/d/1', publication_date: '2026-10-08', dates: 'Applicable October 8, 2026. Comments due November 7, 2026.', document_number: '1' }, '2026-10-16');
  assert.deepStrictEqual([a.stage, a.productKo, a.countriesKo, a.korea], ['prelim', '도금강판', ['한국'], true]);
  assert.deepStrictEqual(a.deadlines, [{ date: '2026-11-07', what: '의견 제출 마감' }, { date: '2027-02-05', what: '최종 판정 예정', est: true }]);  // 연례 재심 예비 → 최종 120일
  const b = shape({ title: 'Certain Cut-to-Length Carbon Steel Plate From the People\'s Republic of China and the Russian Federation: Final Results of the Expedited Fifth Sunset Reviews of the Antidumping Duty Orders', html_url: 'https://x/2', publication_date: '2026-10-05' }, '2026-10-16');
  assert.deepStrictEqual([b.productKo, b.countriesKo, b.korea], ['후판', ['중국', '러시아'], false]);
  assert.strictEqual(b.stage, 'sunset');
  const c = shape({ title: 'Truck Bed Covers From the People\'s Republic of China: Preliminary Affirmative Determination of Sales at Less Than Fair Value, Postponement of Final Determination', html_url: 'https://x/3', publication_date: '2026-10-01', dates: 'The final determination will be issued no later than February 12, 2027.' }, '2026-10-16');
  assert.deepStrictEqual(c.deadlines, [{ date: '2027-02-12', what: '최종 판정 예정' }]);
  const f = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: [
    { title: 'Initiation of Antidumping and Countervailing Duty Administrative Reviews', html_url: 'https://x/0', publication_date: '2026-10-01' },
    { title: 'Xanthan Gum From the People\'s Republic of China: Preliminary Results of Antidumping Duty Administrative Review', html_url: 'https://x/5', publication_date: '2026-10-08' },
    { title: 'Common Alloy Aluminum Sheet From Taiwan: Final Determination of No Shipments', html_url: 'https://x/6', publication_date: '2026-10-08' },
    { title: 'Certain Steel Nails From the Republic of Korea: Preliminary Results of Antidumping Duty Administrative Review', html_url: 'https://x/4', publication_date: '2026-10-08', comments_close_on: '2026-11-09' }] }) });
  const r = await createRemedies({ fetch: f, now: () => new Date('2026-10-16T00:00:00Z') }).get();
  assert.strictEqual(r.items.length, 1);                 // 연례 재심 일괄 공지·비철강(잔탄검·알루미늄)은 뺀다
  assert.deepStrictEqual(r.upcoming.map(u => [u.date, u.what, u.productKo, u.est]), [['2026-11-09', '의견 제출 마감', '못', false], ['2027-02-05', '최종 판정 예정', '못', true]]);
});

test('무역 규제: 실제 관보 제목의 단계 분류와 국가', () => {
  const { stageOf, shape } = require('../lib/remedies');
  const S = t => stageOf(t).stage;
  assert.strictEqual(S('Forged Steel Fluid End Blocks from Italy: Notice of Court Decision Not in Harmony With the Results of Antidumping Administrative Review; Notice of Amended Final Results'), 'court');
  assert.strictEqual(S('Certain Oil Country Tubular Goods From Austria: Preliminary Affirmative Countervailing Duty Determination and Alignment of Final Determination With Final Antidumping Duty Determination'), 'prelim');
  assert.strictEqual(S('Boltless Steel Shelving Units Prepackaged for Sale From the People\'s Republic of China: Continuation of Antidumping Duty Order and Countervailing Duty Order'), 'sunset');
  assert.strictEqual(S('Certain Corrosion-Resistant Steel Products From the People\'s Republic of China: Initiation of Circumvention Inquiry on the Antidumping and Countervailing Duty Orders'), 'scope');
  assert.strictEqual(S('Carbon and Alloy Steel Wire Rod From the Republic of Korea: Notice of Reopening of, and Intent To Reconsider the Final Results of, Antidumping Duty Administrative Review'), 'notice');
  assert.strictEqual(S('Non-Oriented Electrical Steel From Japan: Rescission of Antidumping Duty Administrative Review; 2024-2025'), 'notice');
  assert.strictEqual(S('Carbon and Alloy Steel Wire Rod From Algeria: Final Affirmative Countervailing Duty Determination and Countervailing Duty Order'), 'order');
  assert.strictEqual(S('Steel Concrete Reinforcing Bar From Egypt: Final Affirmative Countervailing Duty Determination'), 'final');
  const r = shape({ title: 'Steel Concrete Reinforcing Bar From Bulgaria, Egypt, and the Socialist Republic of Vietnam: Antidumping Duty Orders', html_url: 'https://x/7', publication_date: '2026-09-01' }, '2026-10-16');
  assert.deepStrictEqual([r.stage, r.productKo, r.countriesKo], ['order', '철근', ['불가리아', '이집트', '베트남']]);
  const t = shape({ title: 'Steel Concrete Reinforcing Bar From the Republic of T[uuml]rkiye: Final Results of Countervailing Duty Administrative Review; 2023', html_url: 'https://x/8', publication_date: '2026-09-01' }, '2026-10-16');
  assert.deepStrictEqual(t.countriesKo, ['튀르키예']);
  const i = shape({ title: 'Welded Stainless Line and Pressure Pipe From India and the Republic of Türkiye: Initiation of Countervailing Duty Investigations', html_url: 'https://x/9', publication_date: '2026-09-20' }, '2026-10-16');
  assert.deepStrictEqual([i.stage, i.productKo, i.deadlines], ['init', '스테인리스 강관', [{ date: '2026-11-24', what: '예비 판정 예정', est: true }]]);
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

test('한국 반덤핑: 기본 사건, 다음 일정(예상 포함), 관리자 저장·검증·초기화', async () => {
  const { createKrRemedies, SEED } = require('../lib/krremedies');
  const { createKv } = require('../lib/kv');
  const kv = createKv();
  const k = createKrRemedies({ kv, now: () => new Date('2026-10-16T00:00:00Z') });
  const g = await k.get();
  assert.strictEqual(g.cases.length, SEED.length);
  const coated = g.cases.find(c => c.id === 'kr-coated');
  assert.deepStrictEqual([coated.last.kind, coated.next.date], ['provisional', '2027-01-11']);
  assert.ok(coated.rates.some(r => r.supplier === '그 밖의 공급자' && r.rate === 25.75));
  assert.deepStrictEqual(g.upcoming.slice(0, 2).map(u => [u.date, u.est]), [['2026-11-18', true], ['2027-01-11', false]]);
  g.cases.forEach(c => { assert.ok(c.sources.length > 0, c.id + ' 출처'); c.sources.forEach(s => assert.ok(/^https:\/\//.test(s.url))); });
  // 관리자 수정
  const edited = SEED.slice(0, 1).map(c => Object.assign({}, c, { events: c.events.concat([{ date: '2026-12-01', kind: 'order', label: '부과 시행' }, { date: 'bad', kind: 'x' }]) }));
  assert.strictEqual((await k.save(edited, '2026-10-20')).count, 1);
  const g2 = await k.get();
  assert.deepStrictEqual([g2.edited, g2.verifiedAt, g2.cases[0].next.label], [true, '2026-10-20', '부과 시행']);
  await assert.rejects(k.save([{ id: '' }]), /required/);
  await k.reset();
  assert.strictEqual((await k.get()).edited, false);
});
