'use strict';
// Vercel 단일 서버 함수: /api/* 요청을 모두 받아 lib/routes.js로 나눈다(vercel.json rewrites).
// API 키는 각 모듈이 환경변수에서만 읽는다.
const { ROUTES, routeName } = require('../lib/routes');

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
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'method_not_allowed' });
  await r.handle(query, (s, b, cc) => send(s, b, cc, r.sMaxAge));
};
