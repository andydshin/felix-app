'use strict';
// 미국 BLS 생산자물가지수. 인증키는 환경변수 BLS_API_KEY에서만 읽는다.
const { makeUsPpiHandler } = require('../lib/bls-handler');
const handle = makeUsPpiHandler();

module.exports = async (req, res) => {
  await handle((status, body, cacheControl) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=3600' : 'no-store');
    res.end(JSON.stringify(body, null, 1));
  });
};
