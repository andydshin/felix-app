'use strict';
// 한국 관세청 품목별 수입 통관 단가. 인증키는 환경변수 CUSTOMS_SERVICE_KEY에서만 읽는다.
const { makeKrTradeHandler } = require('../lib/customs-handler');
const handle = makeKrTradeHandler();

module.exports = async (req, res) => {
  await handle((status, body, cacheControl) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=3600' : 'no-store');
    res.end(JSON.stringify(body));
  });
};
