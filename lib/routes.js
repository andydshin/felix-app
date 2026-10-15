'use strict';
// 모든 API 경로 → 처리 함수. 로컬 server.js와 Vercel 단일 함수(api/router.js)가 함께 쓴다.
// (Vercel Hobby 플랜은 배포당 서버 함수 12개 제한이 있어 함수 하나로 묶는다.)
const { makeHandler } = require('./handler');
const { makeProbeHandler, makeJpTradeHandler } = require('./estat-handler');
const { makeKrProbeHandler, makeKrTradeHandler } = require('./customs-handler');
const { makeFxHandler, makeFxProbeHandler } = require('./fx-handler');
const { makeKrPpiHandler, makeKrPpiProbeHandler } = require('./kosis-handler');
const { makeFxDailyHandler, makeFxDailyProbeHandler } = require('./eximfx-handler');
const { makeUsPpiHandler, makeUsPpiProbeHandler } = require('./bls-handler');
const { makeCnPricesHandler, makeCnPricesProbeHandler } = require('./nbs-handler');
const { makeWorldPricesHandler, makeWorldPricesProbeHandler } = require('./worldbank-handler');
const { makeInWpiHandler, makeInWpiProbeHandler } = require('./india-handler');
const { makeMxProbeHandler } = require('./inegi-handler');
const { makeMxTradeHandler, makeMxTradeProbeHandler } = require('./mxtrade-handler');
const { makeEuPricesHandler, makeEuProbeHandler } = require('./eurostat-handler');
const { makeReportHandlers, createReport } = require('./report');
const { createKv } = require('./kv');
const { createHistory } = require('./history');
const { createVotes } = require('./votes');
const { createHsTrade, HsError } = require('./hstrade');

const census = makeHandler();
const noQuery = h => (query, send) => h(send);
const kv = createKv();
const history = createHistory({ kv });
const votes = createVotes({ kv });
const hs = createHsTrade({ kv });
const hsSafe = fn => async (q, send) => { try { await fn(q, send); } catch (e) { if (e instanceof HsError) return send(e.status === 'bad_codes' ? 400 : 502, { error: String(e.status), message: e.detail }); send(502, { error: 'internal', message: String(e && (e.status || e.message) || '') }); } };
const rep = makeReportHandlers(createReport({ kv, history, votes }));
const safe = fn => async (q, send, ctx) => { try { await fn(q, send, ctx); } catch (e) { console.error('route error ' + (e && (e.status || e.message))); send(502, { error: 'storage', message: String(e && (e.status || e.message) || '') }); } };

// name → { handle(query, send, ctx), sMaxAge, post? }  ctx = { method, headers, body }
const ROUTES = {
  'us-state-imports': { handle: (q, send) => census(q, send), sMaxAge: 3600 },
  'jp-trade': { handle: noQuery(makeJpTradeHandler()), sMaxAge: 3600 },
  'jp-probe': { handle: noQuery(makeProbeHandler()), sMaxAge: 3600 },
  'kr-trade': { handle: noQuery(makeKrTradeHandler()), sMaxAge: 3600 },
  'kr-probe': { handle: noQuery(makeKrProbeHandler()), sMaxAge: 3600 },
  'fx': { handle: noQuery(makeFxHandler()), sMaxAge: 3600 },
  'fx-probe': { handle: noQuery(makeFxProbeHandler()), sMaxAge: 3600 },
  'fx-daily': { handle: noQuery(makeFxDailyHandler()), sMaxAge: 1800 },
  'fx-daily-probe': { handle: noQuery(makeFxDailyProbeHandler()), sMaxAge: 1800 },
  'kr-ppi': { handle: noQuery(makeKrPpiHandler()), sMaxAge: 3600 },
  'kr-ppi-probe': { handle: noQuery(makeKrPpiProbeHandler()), sMaxAge: 3600 },
  'us-ppi': { handle: noQuery(makeUsPpiHandler()), sMaxAge: 3600 },
  'us-ppi-probe': { handle: noQuery(makeUsPpiProbeHandler()), sMaxAge: 3600 },
  'cn-prices': { handle: noQuery(makeCnPricesHandler()), sMaxAge: 3600 },
  'cn-prices-probe': { handle: noQuery(makeCnPricesProbeHandler()), sMaxAge: 3600 },
  'world-prices': { handle: noQuery(makeWorldPricesHandler()), sMaxAge: 3600 },
  'world-prices-probe': { handle: noQuery(makeWorldPricesProbeHandler()), sMaxAge: 3600 },
  'in-wpi': { handle: noQuery(makeInWpiHandler()), sMaxAge: 3600 },
  'in-wpi-probe': { handle: noQuery(makeInWpiProbeHandler()), sMaxAge: 3600 },
  'mx-probe': { handle: noQuery(makeMxProbeHandler()), sMaxAge: 3600 },
  'mx-trade': { handle: noQuery(makeMxTradeHandler()), sMaxAge: 3600 },
  'mx-trade-probe': { handle: noQuery(makeMxTradeProbeHandler()), sMaxAge: 3600 },
  'eu-prices': { handle: noQuery(makeEuPricesHandler()), sMaxAge: 3600 },
  'eu-probe': { handle: noQuery(makeEuProbeHandler()), sMaxAge: 3600 },
  // 주간 리포트. post: true인 경로만 POST를 받는다.
  'report': { handle: rep.public, sMaxAge: 300 },
  'report-admin': { handle: rep.admin, sMaxAge: 0, post: true },
  'report-cron': { handle: rep.cron, sMaxAge: 0 },
  'report-probe': { handle: rep.probe, sMaxAge: 0 },
  'signals': { handle: rep.signals, sMaxAge: 1800 },
  'hs': { handle: hsSafe(async (q, send) => send(200, await hs.search(q), 'public, max-age=1800')), sMaxAge: 3600 },
  'hs-probe': { handle: hsSafe(async (q, send) => send(200, await hs.probe())), sMaxAge: 0 },
  // 자체 시계열, 체감 투표
  'history': { handle: safe(async (q, send) => send(200, await history.get(q.keys), 'public, max-age=300')), sMaxAge: 1800 },
  'votes': { handle: safe(async (q, send) => send(200, await votes.results(), 'public, max-age=30')), sMaxAge: 60 },
  'vote': { handle: safe(async (q, send, ctx) => { const r = await votes.vote(ctx && ctx.body); send(r.ok ? 200 : 400, r); }), sMaxAge: 0, post: true }
};

// '/api/us-ppi' 또는 'us-ppi' → 'us-ppi'
function routeName(s) { return String(s || '').replace(/^\/?api\//, '').replace(/^\/+|\/+$/g, '').split('?')[0]; }

module.exports = { ROUTES, routeName };
