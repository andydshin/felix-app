'use strict';
// GET /api/mx-trade → 멕시코산 대미 수출 단가, GET /api/mx-trade-probe → 단위·품목 진단 (키 비노출)
const { createMxTrade, MxConfigError, MxError } = require('./mxtrade');
function make(method, cacheable) {
  return function (service, log) {
    const svc = service || createMxTrade();
    const logger = log || ((m) => console.error(m));
    return async function handle(send) {
      try { send(200, await svc[method](), cacheable ? 'public, max-age=600' : null); }
      catch (e) {
        if (e instanceof MxConfigError) return send(503, { error: 'not_configured', message: '서버에 CENSUS_API_KEY가 설정되지 않았습니다.' });
        if (e instanceof MxError) { logger('mx-trade upstream ' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail }); }
        logger('mx-trade unexpected ' + (e && e.name)); send(502, { error: 'network', message: String(e && e.message || '') });
      }
    };
  };
}
module.exports = { makeMxTradeHandler: make('latest', true), makeMxTradeProbeHandler: make('probe', false) };
