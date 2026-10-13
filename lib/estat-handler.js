'use strict';
// GET /api/jp-probe → e-Stat 무역통계 표 구조 진단 JSON (앱 ID는 응답·로그에 넣지 않는다)
const { createEstat, EstatConfigError, EstatUpstreamError } = require('./estat');
const { createJpTrade } = require('./jptrade');
const { createFx } = require('./fx');

function makeProbeHandler(service, log) {
  const svc = service || createEstat();
  const logger = log || ((m) => console.error(m));
  let cache = null; // 진단 결과는 1시간 재사용 (e-Stat에 짧은 시간 대량 호출 금지)
  return async function handle(send) {
    try {
      if (cache && cache.exp > Date.now()) return send(200, Object.assign({ cache: 'hit' }, cache.value), 'public, max-age=600');
      const value = await svc.probe();
      cache = { value, exp: Date.now() + 60 * 60 * 1000 };
      send(200, value, 'public, max-age=600');
    } catch (e) {
      if (e instanceof EstatConfigError) { logger('estat config error: app id missing'); return send(503, { error: 'not_configured', message: '서버에 ESTAT_APP_ID가 설정되지 않았습니다. 설정 후 Redeploy 하세요.' }); }
      if (e instanceof EstatUpstreamError) { logger('estat upstream error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || 'e-Stat API 응답 오류' }); }
      logger('estat unexpected error type=' + (e && e.name));
      send(500, { error: 'internal' });
    }
  };
}

// GET /api/jp-trade → 일본 품목별 수출·수입 단가(엔/t)
function prevYm(ym) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

// 엔/t → 달러/t: 관세청 수입 과세환율 월평균으로 환산 (원/100엔 ÷ 100 ÷ 원/달러). 환율을 못 받으면 엔화만 둔다.
async function withUsd(data, fx, logger) {
  if (!fx || !process.env.CUSTOMS_SERVICE_KEY) return data;
  try {
    const memo = {};
    const rate = async ym => { if (!(ym in memo)) { const a = await fx.monthAvg(ym); memo[ym] = a && a.USD > 0 && a.JPY100 > 0 ? { usdPerJpy: a.JPY100 / 100 / a.USD, a } : null; } return memo[ym]; };
    const items = [];
    for (const it of data.items) {
      const o = Object.assign({}, it);
      if (it.status === 'ok' && it.month) { const r = await rate(it.month); if (r) { o.unitPriceUsd = Math.round(it.unitPriceJpy * r.usdPerJpy * 100) / 100; o.fxMonth = it.month; } }
      if (it.prev && it.prev.status === 'ok' && it.month) { const r = await rate(prevYm(it.month)); if (r) o.prev = Object.assign({}, it.prev, { unitPriceUsd: Math.round(it.prev.unitPriceJpy * r.usdPerJpy * 100) / 100 }); }
      items.push(o);
    }
    const fxUsed = Object.keys(memo).filter(k => memo[k]).map(k => ({ month: k, USD: memo[k].a.USD, JPY100: memo[k].a.JPY100, weeks: memo[k].a.weeks }));
    return Object.assign({}, data, { items, fx: { source: '관세청 관세환율(수입) 월평균', months: fxUsed } });
  } catch (e) { logger('jp fx skipped type=' + (e && e.name)); return data; }
}

function makeJpTradeHandler(service, log, fx) {
  const svc = service || createJpTrade();
  const logger = log || ((m) => console.error(m));
  const fxSvc = fx === undefined ? createFx() : fx;
  return async function handle(send) {
    try {
      send(200, await withUsd(await svc.latest(), fxSvc, logger), 'public, max-age=600');
    } catch (e) {
      if (e instanceof EstatConfigError) { logger('estat config error: app id missing'); return send(503, { error: 'not_configured', message: '서버에 ESTAT_APP_ID가 설정되지 않았습니다.' }); }
      if (e instanceof EstatUpstreamError) { logger('estat upstream error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || 'e-Stat API 응답 오류' }); }
      logger('estat unexpected error type=' + (e && e.name));
      send(500, { error: 'internal' });
    }
  };
}

module.exports = { makeProbeHandler, makeJpTradeHandler };
