'use strict';
// GET /api/eu-prices → 유럽(Comext 역외 수입 단가 + PPI 보완), GET /api/eu-probe → 진단
const { createEurostat, EuError } = require('./eurostat');
function make(method, cacheable) {
  return function (service, log) {
    const svc = service || createEurostat();
    const logger = log || ((m) => console.error(m));
    return async function handle(send) {
      try { send(200, await svc[method](), cacheable ? 'public, max-age=600' : null); }
      catch (e) {
        if (e instanceof EuError) { logger('eurostat ' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail }); }
        logger('eurostat unexpected ' + (e && e.message)); send(502, { error: 'network', message: String(e && e.message || '') });
      }
    };
  };
}
module.exports = { makeEuPricesHandler: make('latest', true), makeEuProbeHandler: make('probe', false) };
