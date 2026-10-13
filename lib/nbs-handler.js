'use strict';
// GET /api/cn-prices → 중국 국가통계국 열흘 유통가격, GET /api/cn-prices-probe → 목록·파싱 진단
const { createNbs, NbsError } = require('./nbs');

function make(method, cacheable) {
  return function (service, log) {
    const svc = service || createNbs();
    const logger = log || ((m) => console.error(m));
    return async function handle(send) {
      try { send(200, await svc[method](), cacheable ? 'public, max-age=600' : null); }
      catch (e) {
        if (e instanceof NbsError) { logger('nbs error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || '국가통계국 페이지를 읽지 못했습니다.' }); }
        logger('nbs unexpected error type=' + (e && e.name));
        send(502, { error: 'network', message: '국가통계국 서버에 연결하지 못했습니다.' });
      }
    };
  };
}
module.exports = { makeCnPricesHandler: make('latest', true), makeCnPricesProbeHandler: make('probe', false) };
