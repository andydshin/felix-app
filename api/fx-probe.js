'use strict';
// 관세청 관세환율. 인증키는 환경변수 CUSTOMS_SERVICE_KEY에서만 읽는다.
const { makeFxProbeHandler } = require('../lib/fx-handler');
const handle = makeFxProbeHandler();

module.exports = async (req, res) => {
  await handle((status, body, cacheControl) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=3600' : 'no-store');
    res.end(JSON.stringify(body, null, 1));
  });
};
