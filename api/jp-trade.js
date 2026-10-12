'use strict';
// 일본 재무성 무역통계(e-Stat) 품목별 수출·수입 단가. 앱 ID는 환경변수 ESTAT_APP_ID에서만 읽는다.
const { makeJpTradeHandler } = require('../lib/estat-handler');
const handle = makeJpTradeHandler();

module.exports = async (req, res) => {
  await handle((status, body, cacheControl) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=3600' : 'no-store');
    res.end(JSON.stringify(body));
  });
};
