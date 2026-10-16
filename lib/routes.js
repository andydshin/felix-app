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
const { createArchive } = require('./archive');
const { createKrRemedies } = require('./krremedies');
const { createPanel } = require('./panel');
const { createHsTrade, HsError } = require('./hstrade');
const { createHsNotes } = require('./hsnotes');
const { createRemedies } = require('./remedies');

const census = makeHandler();
const noQuery = h => (query, send) => h(send);
const kv = createKv();
const history = createHistory({ kv });
const panel = createPanel({ kv });
const hs = createHsTrade({ kv });
const hsNotes = createHsNotes({ kv });
const remedies = createRemedies({ kv });
const krrem = createKrRemedies({ kv });
const hsSafe = fn => async (q, send) => { try { await fn(q, send); } catch (e) { if (e instanceof HsError) return send(e.status === 'bad_codes' ? 400 : 502, { error: String(e.status), message: e.detail }); send(502, { error: 'internal', message: String(e && (e.status || e.message) || '') }); } };
// 체감 투표는 2026-10 사용자 화면에서 내림(정보교환 리스크·초기 표본 부족). lib/votes.js는 보관만 한다.
const rep = makeReportHandlers(createReport({ kv, history, votes: null, hsNotes, panel, archive: createArchive({ kv }), krrem }));
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
  'hs': { handle: hsSafe(async (q, send) => { const r = await hs.search(q); const done = !r.mainError && !(r.comtradeMeta && r.comtradeMeta.failed && r.comtradeMeta.failed.length); send(200, Object.assign({}, r, { notes: await hsNotes.forQuery(r.market, r.codes).catch(() => []) }), done && q.fresh !== '1' ? 'public, max-age=600' : null); }), sMaxAge: 600 },
  'hs-probe': { handle: hsSafe(async (q, send) => send(200, await hs.probe())), sMaxAge: 0 },
  // 자체 시계열, 체감 투표
  'history': { handle: safe(async (q, send) => send(200, await history.get(q.keys), 'public, max-age=300')), sMaxAge: 1800 },
  'track': { handle: rep.track, sMaxAge: 1800 },
  'remedies': { handle: safe(async (q, send) => send(200, await remedies.get(), 'public, max-age=1800')), sMaxAge: 3600 },
  'kr-remedies': { handle: safe(async (q, send) => send(200, await krrem.get(), 'public, max-age=600')), sMaxAge: 3600 },
  'panel': { handle: safe(async (q, send, ctx) => { const r = await panel.register(ctx && ctx.body); send(r.ok ? 200 : 400, r); }), sMaxAge: 0, post: true }
};

// '/api/us-ppi' 또는 'us-ppi' → 'us-ppi'
function routeName(s) { return String(s || '').replace(/^\/?api\//, '').replace(/^\/+|\/+$/g, '').split('?')[0]; }

module.exports = { ROUTES, routeName };
