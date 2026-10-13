'use strict';
// 의존성 없는 Node 서버 (Node 18 이상): 정적 앱(public/)과 Census 프록시 API를 함께 제공한다.
// 실행: CENSUS_API_KEY=... node server.js   (키는 환경변수로만 넣는다)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const { ROUTES, routeName } = require('./lib/routes');

function sendJson(res, status, body, cacheControl) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl || 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const r = ROUTES[routeName(url.pathname)];
    if (!r) return sendJson(res, 404, { error: 'not_found' });
    const isPost = req.method === 'POST' && r.post;
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isPost) return sendJson(res, 405, { error: 'method_not_allowed' });
    let body = null;
    if (isPost) { try { const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > 300000) throw new Error('big'); ch.push(c); } body = JSON.parse(Buffer.concat(ch).toString('utf8') || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad_body' }); } }
    return r.handle(Object.fromEntries(url.searchParams), (s, b, cc) => sendJson(res, s, b, cc), { method: req.method, headers: req.headers, body });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, keyConfigured: Boolean(process.env.CENSUS_API_KEY), estatConfigured: Boolean(process.env.ESTAT_APP_ID), customsConfigured: Boolean(process.env.CUSTOMS_SERVICE_KEY), kosisConfigured: Boolean(process.env.KOSIS_API_KEY), keximConfigured: Boolean(process.env.KOREAEXIM_API_KEY), blsConfigured: Boolean(process.env.BLS_API_KEY), aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY), adminConfigured: Boolean(process.env.FELIX_ADMIN_TOKEN) });
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log('Felix server on http://localhost:' + PORT + ' (Census key ' + (process.env.CENSUS_API_KEY ? 'configured' : 'NOT configured') + ')'));
