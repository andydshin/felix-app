'use strict';
// GET /api/mx-probe → INEGI 토큰 확인·지표 목록 진단 (토큰은 응답·로그에 넣지 않는다)
const { createInegi, InegiConfigError } = require('./inegi');
function makeMxProbeHandler(service, log) {
  const svc = service || createInegi();
  const logger = log || ((m) => console.error(m));
  return async function handle(send) {
    try { send(200, await svc.probe(), null); }
    catch (e) {
      if (e instanceof InegiConfigError) { logger('inegi config error: token missing'); return send(503, { error: 'not_configured', message: '서버에 INEGI_TOKEN이 설정되지 않았습니다. 설정 후 Redeploy 하세요.' }); }
      logger('inegi unexpected ' + (e && e.name)); send(502, { error: 'network' });
    }
  };
}
module.exports = { makeMxProbeHandler };
