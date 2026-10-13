'use strict';
// GET /api/us-ppi → 미국 PPI 3종, GET /api/us-ppi-probe → 후보 시리즈 제목·최신값 진단. 키는 응답·로그에 넣지 않는다.
const { createBls, BlsConfigError, BlsUpstreamError } = require('./bls');

function make(method, cacheable) {
  return function (service, log) {
    const svc = service || createBls();
    const logger = log || ((m) => console.error(m));
    return async function handle(send) {
      try { send(200, await svc[method](), cacheable ? 'public, max-age=600' : null); }
      catch (e) {
        if (e instanceof BlsConfigError) { logger('bls config error: key missing'); return send(503, { error: 'not_configured', message: '서버에 BLS_API_KEY가 설정되지 않았습니다. 설정 후 Redeploy 하세요.' }); }
        if (e instanceof BlsUpstreamError) { logger('bls upstream error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || 'BLS API 응답 오류' }); }
        logger('bls unexpected error type=' + (e && e.name));
        send(502, { error: 'network', message: 'BLS 서버에 연결하지 못했습니다.' });
      }
    };
  };
}
module.exports = { makeUsPpiHandler: make('latest', true), makeUsPpiProbeHandler: make('probe', false) };
