'use strict';
// GET /api/jp-probe → e-Stat 무역통계 표 구조 진단 JSON (앱 ID는 응답·로그에 넣지 않는다)
const { createEstat, EstatConfigError, EstatUpstreamError } = require('./estat');

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

module.exports = { makeProbeHandler };
