'use strict';
// 진단용: 관세청 품목별 국가별 수출입실적 API 응답 구조 확인. 키는 환경변수 CUSTOMS_SERVICE_KEY에서만 읽는다.
const { makeKrProbeHandler } = require('../lib/customs-handler');
const handle = makeKrProbeHandler();

module.exports = async (req, res) => {
  await handle((status, body, cacheControl) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=3600' : 'no-store');
    res.end(JSON.stringify(body, null, 1));
  });
};
