'use strict';
// GET /api/kr-ppi       → 국내 생산자물가지수 철강 8종
// GET /api/kr-ppi-probe → 표·품목 찾기 진단
// 인증키는 응답·로그에 넣지 않는다.
const { createKosis, KosisConfigError, KosisUpstreamError } = require('./kosis');

function make(method, cacheable) {
  return function (service, log) {
    const svc = service || createKosis();
    const logger = log || ((m) => console.error(m));
    return async function handle(send) {
      try { send(200, await svc[method](), cacheable ? 'public, max-age=600' : null); }
      catch (e) {
        if (e instanceof KosisConfigError) { logger('kosis config error: key missing'); return send(503, { error: 'not_configured', message: '서버에 KOSIS_API_KEY가 설정되지 않았습니다. 설정 후 Redeploy 하세요.' }); }
        if (e instanceof KosisUpstreamError) { logger('kosis upstream error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || 'KOSIS API 응답 오류' }); }
        logger('kosis unexpected error type=' + (e && e.name));
        send(500, { error: 'internal' });
      }
    };
  };
}

module.exports = { makeKrPpiHandler: make('latest', true), makeKrPpiProbeHandler: make('probe', false) };
