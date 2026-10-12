'use strict';
// 서버리스(Vercel) 배포용 함수. 키는 프로젝트 설정의 환경변수 CENSUS_API_KEY에서 읽는다.
// 같은 lib를 쓰므로 계산·캐시·오류 처리는 server.js와 동일하다. (캐시는 인스턴스 메모리 기준)
const { makeHandler } = require('../lib/handler');
const handle = makeHandler();

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  await handle(Object.fromEntries(url.searchParams), (status, body, cacheControl) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl ? cacheControl + ', s-maxage=3600' : 'no-store');
    res.end(JSON.stringify(body));
  });
};
