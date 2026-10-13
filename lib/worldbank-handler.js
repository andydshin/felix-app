'use strict';
// GET /api/world-prices → 세계은행 월평균 가격, GET /api/world-prices-probe → 파일 위치·파싱 진단
const { createWorldBank, WbError } = require('./worldbank');

function make(method, cacheable) {
  return function (service, log) {
    const svc = service || createWorldBank();
    const logger = log || ((m) => console.error(m));
    return async function handle(send) {
      try { send(200, await svc[method](), cacheable ? 'public, max-age=600' : null); }
      catch (e) {
        if (e instanceof WbError) { logger('worldbank error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || '세계은행 자료를 읽지 못했습니다.' }); }
        logger('worldbank unexpected error type=' + (e && e.name) + ' ' + (e && e.message));
        send(502, { error: 'parse_or_network', message: String(e && e.message || '') });
      }
    };
  };
}
module.exports = { makeWorldPricesHandler: make('latest', true), makeWorldPricesProbeHandler: make('probe', false) };
