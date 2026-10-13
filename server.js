'use strict';
// 의존성 없는 Node 서버 (Node 18 이상): 정적 앱(public/)과 Census 프록시 API를 함께 제공한다.
// 실행: CENSUS_API_KEY=... node server.js   (키는 환경변수로만 넣는다)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeHandler } = require('./lib/handler');

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const handle = makeHandler();
const { makeProbeHandler, makeJpTradeHandler } = require('./lib/estat-handler');
const handleJpProbe = makeProbeHandler();
const handleJpTrade = makeJpTradeHandler();
const { makeKrProbeHandler, makeKrTradeHandler } = require('./lib/customs-handler');
const handleKrProbe = makeKrProbeHandler();
const handleKrTrade = makeKrTradeHandler();
const { makeFxHandler, makeFxProbeHandler } = require('./lib/fx-handler');
const handleFx = makeFxHandler();
const handleFxProbe = makeFxProbeHandler();
const { makeKrPpiHandler, makeKrPpiProbeHandler } = require('./lib/kosis-handler');
const handleKrPpi = makeKrPpiHandler();
const handleKrPpiProbe = makeKrPpiProbeHandler();

function sendJson(res, status, body, cacheControl) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl || 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/api/us-state-imports') {
    return handle(Object.fromEntries(url.searchParams), (s, b, cc) => sendJson(res, s, b, cc));
  }
  if (url.pathname === '/api/kr-ppi') return handleKrPpi((s, b, cc) => sendJson(res, s, b, cc));
  if (url.pathname === '/api/kr-ppi-probe') return handleKrPpiProbe((s, b, cc) => sendJson(res, s, b, cc));
  if (url.pathname === '/api/fx') return handleFx((s, b, cc) => sendJson(res, s, b, cc));
  if (url.pathname === '/api/fx-probe') return handleFxProbe((s, b, cc) => sendJson(res, s, b, cc));
  if (url.pathname === '/api/kr-trade') return handleKrTrade((s, b, cc) => sendJson(res, s, b, cc));
  if (url.pathname === '/api/kr-probe') return handleKrProbe((s, b, cc) => sendJson(res, s, b, cc));
  if (url.pathname === '/api/jp-trade') return handleJpTrade((s, b, cc) => sendJson(res, s, b, cc));
  if (url.pathname === '/api/jp-probe') return handleJpProbe((s, b, cc) => sendJson(res, s, b, cc));
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, keyConfigured: Boolean(process.env.CENSUS_API_KEY), estatConfigured: Boolean(process.env.ESTAT_APP_ID), customsConfigured: Boolean(process.env.CUSTOMS_SERVICE_KEY), kosisConfigured: Boolean(process.env.KOSIS_API_KEY) });
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
