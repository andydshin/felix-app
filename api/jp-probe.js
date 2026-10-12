'use strict';
// 진단용: 일본 무역통계 표 번호와 구조를 확인한다. 앱 ID는 환경변수 ESTAT_APP_ID에서만 읽고 응답에 넣지 않는다.
const { makeProbeHandler } = require('../lib/estat-handler');
const handle = makeProbeHandler();

module.exports = async (req, res) => {
  await handle((status, body, cacheControl) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=3600' : 'no-store');
    res.end(JSON.stringify(body, null, 1));
  });
};
