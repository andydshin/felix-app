'use strict';
// 일별 원자료 보관소. 발표처 상당수가 '최신 값'만 보여 주고 과거를 남기지 않는다(중국 현물가, 통관 단가, 환율 고시 등).
// 매일 크론이 받은 원자료 전체를 그날 날짜로 한 번만(덮어쓰기 없음) 저장해 두면, 시간이 지날수록 다시 만들 수 없는 기록이 된다.
//  저장소: KV 'arc:v1:YYYY-MM-DD' = { d, at, prev, sha, bytes, z }   z = gzip(JSON(payload)) base64
//          KV 'arc:v1:index'     = [{ d, sha, bytes, parts }]  (최근 → 과거)
//  sha = SHA-256(prev + payload JSON) → 하루치를 나중에 고치면 그 뒤 모든 지문이 어긋난다.
//  공개하지 않는다. 관리자만 목록·내려받기(admin action: archive-list / archive-get).
const crypto = require('crypto');
const zlib = require('zlib');

const PFX = 'arc:v1:';
const IDX = PFX + 'index';
const RAW_LIMIT = 450 * 1024;   // 압축 후 이보다 크면 원자료(raw)는 빼고 정리된 값(rows)만 남긴다

function kstDate(d) { return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function pack(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64'); }
function unpack(z) { return JSON.parse(zlib.gunzipSync(Buffer.from(z, 'base64')).toString('utf8')); }

function createArchive(opts) {
  const kv = opts.kv, now = (opts && opts.now) || (() => new Date());
  return {
    // parts: { raw, rows, status, signals, inputs ... } — 없는 건 빼고 저장
    async save(parts, day) {
      const d = day || kstDate(now());
      const key = PFX + d;
      if (await kv.get(key)) return { day: d, skipped: 'exists' };
      const payload = {};
      Object.keys(parts || {}).forEach(k => { if (parts[k] != null) payload[k] = parts[k]; });
      let z = pack(payload), trimmed = false;
      if (Buffer.byteLength(z) > RAW_LIMIT && payload.raw) { delete payload.raw; trimmed = true; z = pack(payload); }
      const index = (await kv.get(IDX)) || [];
      const prev = index[0] ? index[0].sha : 'genesis';
      const body = JSON.stringify(payload), sha = sha256(prev + body);
      const rec = { d, at: now().toISOString(), prev, sha, bytes: Buffer.byteLength(z), z };
      // 같은 날 두 번 돌아도 처음 것만 남긴다
      const ok = kv.cmd ? await kv.cmd(['SET', key, JSON.stringify(rec), 'NX']) : await kv.set(key, rec);
      if (ok == null) return { day: d, skipped: 'exists' };
      const nextIdx = [{ d, sha, bytes: rec.bytes, parts: Object.keys(payload) }].concat(index.filter(x => x.d !== d)).slice(0, 4000);
      await kv.set(IDX, nextIdx);
      return { day: d, sha: sha.slice(0, 12), bytes: rec.bytes, parts: Object.keys(payload), trimmed };
    },
    async list() {
      const index = (await kv.get(IDX)) || [];
      const total = index.reduce((a, x) => a + (x.bytes || 0), 0);
      return { days: index.length, first: index.length ? index[index.length - 1].d : null, last: index[0] ? index[0].d : null, totalBytes: total, head: index[0] ? index[0].sha : null, items: index.slice(0, 120) };
    },
    async get(day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return { error: 'bad_day' };
      const rec = await kv.get(PFX + day);
      if (!rec) return { error: 'not_found' };
      const payload = unpack(rec.z);
      const okSha = sha256(rec.prev + JSON.stringify(payload)) === rec.sha;
      return { d: rec.d, at: rec.at, prev: rec.prev, sha: rec.sha, verified: okSha, payload };
    },
    // 전체 사슬 검증: 각 날짜의 prev가 직전 날짜의 sha와 이어지는지
    async verify(limit) {
      const all = (await kv.get(IDX)) || [];
      const index = all.slice(0, limit || 120).reverse();
      let prev = null, broken = null;
      for (const x of index) {
        const rec = await kv.get(PFX + x.d);
        if (!rec || (prev !== null && rec.prev !== prev) || sha256(rec.prev + JSON.stringify(unpack(rec.z))) !== rec.sha) { broken = x.d; break; }
        prev = rec.sha;
      }
      return { checked: index.length, days: all.length, ok: !broken, broken, head: all[0] ? all[0].sha : null };
    }
  };
}

module.exports = { createArchive, sha256, pack, unpack };
