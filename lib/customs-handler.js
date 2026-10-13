'use strict';
// GET /api/kr-probe → 관세청 API 응답 구조 진단 (인증키는 응답·로그에 넣지 않는다)
const { createCustoms, CustomsConfigError, CustomsUpstreamError } = require('./customs');
const { createKrTrade } = require('./krtrade');

function makeKrProbeHandler(service, log) {
  const svc = service || createCustoms();
  const logger = log || ((m) => console.error(m));
  let cache = null; // 1시간 재사용
  return async function handle(send) {
    try {
      if (cache && cache.exp > Date.now()) return send(200, Object.assign({ cache: 'hit' }, cache.value), 'public, max-age=600');
      const value = await svc.probe();
      if (value.results.some(r => r.ok)) cache = { value, exp: Date.now() + 60 * 60 * 1000 };
      send(200, value, value.results.some(r => r.ok) ? 'public, max-age=600' : null);
    } catch (e) {
      if (e instanceof CustomsConfigError) { logger('customs config error: key missing'); return send(503, { error: 'not_configured', message: '서버에 CUSTOMS_SERVICE_KEY가 설정되지 않았습니다. 설정 후 Redeploy 하세요.' }); }
      logger('customs unexpected error type=' + (e && e.name));
      send(500, { error: 'internal' });
    }
  };
}

// GET /api/kr-trade → 한국 품목별 수입 통관 단가(달러/t)
function makeKrTradeHandler(service, log) {
  const svc = service || createKrTrade();
  const logger = log || ((m) => console.error(m));
  return async function handle(send) {
    try {
      send(200, await svc.latest(), 'public, max-age=600');
    } catch (e) {
      if (e instanceof CustomsConfigError) { logger('customs config error: key missing'); return send(503, { error: 'not_configured', message: '서버에 CUSTOMS_SERVICE_KEY가 설정되지 않았습니다.' }); }
      if (e instanceof CustomsUpstreamError) { logger('customs upstream error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || '관세청 API 응답 오류' }); }
      logger('customs unexpected error type=' + (e && e.name));
      send(500, { error: 'internal' });
    }
  };
}

module.exports = { makeKrProbeHandler, makeKrTradeHandler };
