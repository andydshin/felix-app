'use strict';
// GET /api/fx-daily       → 수출입은행 최근 영업일 매매기준율(USD, CNH, JPY100)
// GET /api/fx-daily-probe → 최근 5일 응답 진단
// 인증키는 응답·로그에 넣지 않는다.
const { createEximFx, EximConfigError, EximUpstreamError } = require('./eximfx');

function make(method, cacheable) {
  return function (service, log) {
    const svc = service || createEximFx();
    const logger = log || ((m) => console.error(m));
    return async function handle(send) {
      try { send(200, await svc[method](), cacheable ? 'public, max-age=600' : null); }
      catch (e) {
        if (e instanceof EximConfigError) { logger('kexim config error: key missing'); return send(503, { error: 'not_configured', message: '서버에 KOREAEXIM_API_KEY가 설정되지 않았습니다. 설정 후 Redeploy 하세요.' }); }
        if (e instanceof EximUpstreamError) { logger('kexim upstream error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || '수출입은행 API 응답 오류' }); }
        logger('kexim unexpected error type=' + (e && e.name));
        send(502, { error: 'network', message: '수출입은행 서버에 연결하지 못했습니다.' });
      }
    };
  };
}

module.exports = { makeFxDailyHandler: make('latest', true), makeFxDailyProbeHandler: make('probe', false) };
