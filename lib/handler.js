'use strict';
// GET /api/us-state-imports?state=TX  →  JSON (키는 응답에 포함되지 않는다)
const { createService, ConfigError, UpstreamError } = require('./census');

function makeHandler(service, log) {
  const svc = service || createService();
  const logger = log || ((m) => console.error(m));
  return async function handle(query, send) {
    const state = String(query.state || '').toUpperCase();
    try {
      const data = await svc.stateImports(state);
      send(200, data, 'public, max-age=600');
    } catch (e) {
      if (e && e.code === 'BAD_STATE') return send(400, { error: 'unsupported_state' });
      if (e instanceof ConfigError) { logger('census config error: key missing'); return send(503, { error: 'not_configured', message: '서버에 Census API 키가 설정되지 않았습니다.' }); }
      if (e instanceof UpstreamError) { logger('census upstream error status=' + e.status + ' state=' + state); return send(502, { error: 'upstream', message: 'Census API 응답 오류' }); }
      logger('census unexpected error state=' + state + ' type=' + (e && e.name));
      send(500, { error: 'internal' });
    }
  };
}

module.exports = { makeHandler };
