'use strict';
// 체감 투표(익명). 품목별로 이번 주 방향(오름·보합·내림)을 한 번씩 받는다.
//  POST /api/vote  { item, dir, cid }   cid = 기기마다 만든 임의 문자열(개인정보 아님). 같은 주·품목에 한 번만 센다.
//  GET  /api/votes                      이번 주·지난주 품목별 집계
// 개별 응답은 저장하지 않고 합계만 저장한다. 앱은 응답 5건 이상일 때만 비율을 보여 준다.
const ITEMS = ['hr', 'cr', 'gi', 'rb', 'hb'];
const DIRS = ['up', 'flat', 'down'];
const TTL = 120 * 86400;

// KST 기준 ISO 주차 'YYYY-Www'
function weekId(d) {
  const k = new Date(d.getTime() + 9 * 3600000);
  const t = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return t.getUTCFullYear() + '-W' + String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0');
}

function createVotes(opts) {
  const kv = opts.kv, now = opts.now || (() => new Date());
  async function counts(week) {
    const out = {};
    for (const it of ITEMS) {
      const flat = (await kv.cmd(['HGETALL', 'vote:' + week + ':' + it])) || [];
      const c = { up: 0, flat: 0, down: 0 };
      for (let i = 0; i + 1 < flat.length; i += 2) if (DIRS.includes(flat[i])) c[flat[i]] = Number(flat[i + 1]) || 0;
      out[it] = Object.assign(c, { n: c.up + c.flat + c.down });
    }
    return out;
  }
  return {
    async vote(b) {
      const item = String(b && b.item || ''), dir = String(b && b.dir || ''), cid = String(b && b.cid || '').slice(0, 64);
      if (!ITEMS.includes(item) || !DIRS.includes(dir) || !/^[A-Za-z0-9_-]{8,64}$/.test(cid)) return { ok: false, error: 'bad_vote' };
      const week = weekId(now()), vk = 'voters:' + week + ':' + item;
      const fresh = await kv.cmd(['SADD', vk, cid]);
      if (Number(fresh) === 1) { await kv.cmd(['HINCRBY', 'vote:' + week + ':' + item, dir, 1]); await kv.cmd(['EXPIRE', vk, TTL]); await kv.cmd(['EXPIRE', 'vote:' + week + ':' + item, TTL]); }
      return { ok: true, counted: Number(fresh) === 1, week, item, result: (await counts(week))[item] };
    },
    async results() {
      const w = weekId(now()), lw = weekId(new Date(now().getTime() - 7 * 86400000));
      return { status: 'ok', week: w, lastWeek: lw, items: await counts(w), last: await counts(lw), minN: 5 };
    }
  };
}

module.exports = { createVotes, weekId, ITEMS };
