'use strict';
// GET /api/in-wpi → 인도 WPI 품목별, GET /api/in-wpi-probe → 파일 구조·품목 후보 진단
const { createIndia, IndiaError } = require('./india');

function make(method, cacheable) {
  return function (service, log) {
    const svc = service || createIndia();
    const logger = log || ((m) => console.error(m));
    return async function handle(send) {
      try { send(200, await svc[method](), cacheable ? 'public, max-age=600' : null); }
      catch (e) {
        if (e instanceof IndiaError) { logger('india error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail }); }
        logger('india unexpected error ' + (e && e.message));
        send(502, { error: 'parse_or_network', message: String(e && e.message || ''), cause: e && e.cause ? String(e.cause.code || e.cause.message || '') : undefined });
      }
    };
  };
}
module.exports = { makeInWpiHandler: make('latest', true), makeInWpiProbeHandler: make('probe', false) };
