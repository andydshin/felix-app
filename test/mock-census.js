'use strict';
// 통합 테스트용 가짜 Census 서버. 키가 맞을 때만 응답하고, 9월은 미발표(204)로 흉내 낸다.
const http = require('http');
const KEY = process.env.MOCK_EXPECT_KEY;
const PORT = Number(process.env.MOCK_PORT) || 8799;
const DATA = {
  '7210|2026-08': ['15391630', '15017927', '0', '13960234', '0'],
  '7210|2026-07': ['1', '1000000', '0', '1000000', '0'],
  '7209|2026-08': ['1', '2400000', '100000', '2000000', '0'],
  '7601|2026-08': ['1', '9000000', '0', '2000000', '0'],
  '7208|2026-08': ['1', '5', '0', '0', '0'],
  '720449|2026-08': ['1', '137970', '0', '63853', '0'],
  '720441|2026-07': ['1', '40000', '0', '100000', '0'],
  '720449|2026-07': ['1', '60000', '0', '150000', '0']
};
http.createServer((req, res) => {
  const p = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  if (p.key !== KEY) { res.writeHead(403); return res.end('invalid key'); }
  if (p.time === '2026-09') { res.writeHead(204); return res.end(); }
  if (p.I_COMMODITY === '72') { res.writeHead(200); return res.end(JSON.stringify([['GEN_VAL_MO', 'STATE', 'I_COMMODITY', 'time'], ['1', p.STATE, '72', p.time]])); }
  const v = p.STATE === 'TX' && DATA[p.I_COMMODITY + '|' + p.time];
  if (!v) { res.writeHead(204); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify([['I_COMMODITY_SDESC', 'GEN_VAL_MO', 'VES_VAL_MO', 'AIR_VAL_MO', 'VES_WGT_MO', 'AIR_WGT_MO', 'STATE', 'time', 'I_COMMODITY'], ['DESC'].concat(v, [p.STATE, p.time, p.I_COMMODITY])]));
}).listen(PORT);
