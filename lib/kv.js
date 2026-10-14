'use strict';
// 리포트 저장소: Upstash Redis REST API(Vercel 마켓플레이스 'Upstash for Redis' 연결 시 환경변수가 자동으로 생김).
// 주소·토큰은 서버 환경변수에서만 읽는다: KV_REST_API_URL + KV_REST_API_TOKEN (또는 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
// 설정이 없으면(로컬 개발) 메모리에 저장한다 — 서버가 재시작되면 사라진다.

function conf() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

function createKv(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const mem = new Map();
  async function cmd(args) {
    const c = conf();
    if (!c) {
      const [op, key, val] = args;
      if (op === 'GET') return mem.has(key) ? mem.get(key) : null;
      if (op === 'SET') { mem.set(key, val); return 'OK'; }
      if (op === 'PING') return 'PONG(memory)';
      if (op === 'HINCRBY') { const h = mem.get(key) || {}; h[val] = (Number(h[val]) || 0) + Number(args[3]); mem.set(key, h); return h[val]; }
      if (op === 'HGETALL') { const h = mem.get(key) || {}; return Object.keys(h).flatMap(k => [k, String(h[k])]); }
      if (op === 'SADD') { const st = mem.get(key) || new Set(); const had = st.has(val); st.add(val); mem.set(key, st); return had ? 0 : 1; }
      if (op === 'EXPIRE') return 1;
      return null;
    }
    const res = await fetchImpl(c.url, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw Object.assign(new Error('kv ' + (j.error || res.status)), { status: 'kv-' + res.status });
    return j.result;
  }
  return {
    configured: () => !!conf(),
    ping: () => cmd(['PING']),
    async get(key) { const v = await cmd(['GET', key]); if (v == null) return null; try { return JSON.parse(v); } catch (e) { return null; } },
    async set(key, obj) { return cmd(['SET', key, JSON.stringify(obj)]); },
    cmd
  };
}

module.exports = { createKv };
