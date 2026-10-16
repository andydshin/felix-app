'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createKv } = require('../lib/kv');
const { createArchive } = require('../lib/archive');
const signal = require('../lib/signal');

test('보관소: 하루 한 번만 저장(덮어쓰기 없음), 압축 저장·복원, 지문 사슬 검증', async () => {
  const kv = createKv();
  const a = createArchive({ kv, now: () => new Date('2026-10-16T00:00:00Z') });
  const s1 = await a.save({ rows: [{ key: 'cn:hr', value: 3300 }], status: { cn: 'ok:1' }, empty: null }, '2026-10-15');
  assert.deepStrictEqual(s1.parts, ['rows', 'status']);
  assert.strictEqual((await a.save({ rows: [{ key: 'cn:hr', value: 9999 }] }, '2026-10-15')).skipped, 'exists');
  await a.save({ rows: [{ key: 'cn:hr', value: 3310 }] }, '2026-10-16');
  const g = await a.get('2026-10-15');
  assert.strictEqual(g.payload.rows[0].value, 3300);   // 두 번째 저장이 덮어쓰지 않았다
  assert.strictEqual(g.verified, true);
  const l = await a.list();
  assert.deepStrictEqual([l.days, l.first, l.last], [2, '2026-10-15', '2026-10-16']);
  assert.strictEqual((await a.get('2026-10-16')).prev, g.sha);    // 다음 날은 전날 지문을 잇는다
  assert.strictEqual((await a.verify()).ok, true);
  // 과거 하루치를 몰래 고치면 검증이 깨진다
  const rec = await kv.get('arc:v1:2026-10-15');
  const { pack } = require('../lib/archive');
  rec.z = pack({ rows: [{ key: 'cn:hr', value: 1 }] });
  await kv.set('arc:v1:2026-10-15', rec);
  assert.strictEqual((await a.get('2026-10-15')).verified, false);
  assert.deepStrictEqual([(await a.verify()).ok, (await a.verify()).broken], [false, '2026-10-15']);
  assert.strictEqual((await a.get('../x')).error, 'bad_day');
});

test('신호 기록: 지문 사슬, 변조 탐지, 채점 대기·적중', () => {
  const sigs = [{ id: 'hr', dir: '상승', score: 0.6, conf: '중간', ref: 'kr:hr' }];
  const hist = { 'kr:hr': { pts: [['2026-08', 100]] } };
  let log = signal.logSignals([], sigs, hist, '2026-09-01');
  log = signal.logSignals(log, sigs, hist, '2026-09-10');
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].p, 'genesis');
  assert.strictEqual(log[1].p, log[0].h);
  assert.strictEqual(signal.verifyLog(log).ok, true);
  assert.strictEqual(signal.verifyLog(log).head, log[1].h);
  // 지난 기록의 방향을 바꾸면 깨진다
  const bad = log.map(e => Object.assign({}, e)); bad[0].dir = '하락';
  assert.deepStrictEqual([signal.verifyLog(bad).ok, signal.verifyLog(bad).broken], [false, 0]);
  // 지문이 이미 있으면 다시 만들지 않는다(과거 기록 고정)
  assert.strictEqual(signal.logSignals(log, [], hist, '2026-09-20')[0].h, log[0].h);
  assert.deepStrictEqual(signal.gradeEntry(log[0], hist), { status: 'pending', due: '2026-10' });
  const h2 = { 'kr:hr': { pts: [['2026-08', 100], ['2026-10', 101.2]] } };
  assert.deepStrictEqual(signal.gradeEntry(log[0], h2), { status: 'hit', actual: '상승', pct: 1.2, at: '2026-10' });
});
