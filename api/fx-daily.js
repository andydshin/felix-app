'use strict';
// 한국수출입은행 환율. 인증키는 환경변수 KOREAEXIM_API_KEY에서만 읽는다.
const { makeFxDailyHandler } = require('../lib/eximfx-handler');
const handle = makeFxDailyHandler();

module.exports = async (req, res) => {
  await handle((status, body, cacheControl) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=1800' : 'no-store');
    res.end(JSON.stringify(body, null, 1));
  });
};
