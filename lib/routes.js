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

const census = makeHandler();
const noQuery = h => (query, send) => h(send);

// name → { handle(query, send), sMaxAge }
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
  'cn-prices-probe': { handle: noQuery(makeCnPricesProbeHandler()), sMaxAge: 3600 }
};

// '/api/us-ppi' 또는 'us-ppi' → 'us-ppi'
function routeName(s) { return String(s || '').replace(/^\/?api\//, '').replace(/^\/+|\/+$/g, '').split('?')[0]; }

module.exports = { ROUTES, routeName };
