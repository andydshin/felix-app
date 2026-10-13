'use strict';
// Vercel 단일 서버 함수: /api/* 요청을 모두 받아 lib/routes.js로 나눈다(vercel.json rewrites).
// API 키는 각 모듈이 환경변수에서만 읽는다.
const { ROUTES, routeName } = require('../lib/routes');

// POST 본문(JSON, 최대 300KB). Vercel이 이미 읽어 둔 req.body가 있으면 그대로 쓴다.
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 300000) throw new Error('too_large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(url.searchParams);
  const name = routeName(query.route || url.pathname);
  delete query.route;
  const send = (status, body, cacheControl, sMaxAge) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=' + sMaxAge : 'no-store');
    res.end(JSON.stringify(body, null, /probe$/.test(name) ? 1 : 0));
  };
  const r = ROUTES[name];
  if (!r) return send(404, { error: 'not_found', route: name });
  const isPost = req.method === 'POST' && r.post;
  if (req.method !== 'GET' && req.method !== 'HEAD' && !isPost) return send(405, { error: 'method_not_allowed' });
  let body = null;
  if (isPost) { try { body = await readBody(req); } catch (e) { return send(400, { error: 'bad_body' }); } }
  await r.handle(query, (s, b, cc) => send(s, b, cc, r.sMaxAge), { method: req.method, headers: req.headers || {}, body });
};
