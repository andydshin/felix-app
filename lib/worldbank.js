'use strict';
// 세계은행 Commodity Markets(Pink Sheet) 월간 가격 — CMO-Historical-Data-Monthly.xlsx. 키 없음, CC BY 4.0.
// 파일 주소가 해마다 바뀌어 안내 페이지에서 링크를 찾는다. 못 찾으면 WB_XLSX_URL 또는 마지막으로 확인한 주소를 쓴다.
const { readSheet } = require('./xlsx-lite');

const PAGE = 'https://www.worldbank.org/en/research/commodity-markets';
const KNOWN = process.env.WB_XLSX_URL || 'https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx';
const SOURCE = { name: 'World Bank, Commodity Price Data (The Pink Sheet)', license: 'CC BY 4.0', url: PAGE };
// 앱 항목 ↔ 표 머리글(앞부분 일치, 대소문자 무시)
const WANT = [
  { id: 'iron_ore', header: 'Iron ore' }, { id: 'coal_au', header: 'Coal, Australian' },
  { id: 'al', header: 'Aluminum' }, { id: 'cu', header: 'Copper' }, { id: 'pb', header: 'Lead' },
  { id: 'sn', header: 'Tin' }, { id: 'ni', header: 'Nickel' }, { id: 'zn', header: 'Zinc' }
];
const TTL_MS = 12 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; FelixDataBot/1.0; steel price research)';

class WbError extends Error { constructor(status, detail) { super('World Bank fetch failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }

function findXlsxLink(html) {
  const m = html.match(/https?:\/\/[^"'\s>]*CMO-Historical-Data-Monthly\.xlsx/i) || html.match(/["']([^"']*CMO-Historical-Data-Monthly\.xlsx)["']/i);
  if (!m) return null;
  const u = m[1] || m[0];
  try { return new URL(u, PAGE).toString(); } catch (e) { return null; }
}

// 'Monthly Prices' 시트 → { 머리글 행, 단위, 월별 값 }
function parseMonthly(rows) {
  const hi = rows.findIndex(r => r && r.some(v => typeof v === 'string' && /^iron ore/i.test(v.trim())));
  if (hi < 0) throw new WbError('parse', 'Iron ore 열을 찾지 못했습니다.');
  // 빈 셀은 배열 구멍으로 남으므로 Array.from으로 채운다
  const header = Array.from(rows[hi], v => (typeof v === 'string' ? v.trim() : ''));
  const units = Array.from(rows[hi + 1] || [], v => (typeof v === 'string' ? v.trim() : ''));
  const data = rows.slice(hi + 1).filter(r => r && typeof r[0] === 'string' && /^\d{4}M\d{2}$/.test(r[0].trim()));
  const items = {};
  WANT.forEach(w => {
    const ci = header.findIndex(h => h.toLowerCase().startsWith(w.header.toLowerCase()));
    if (ci < 0) return;
    const pts = data.map(r => ({ ym: r[0].trim().replace('M', '-'), v: r[ci] })).filter(p => typeof p.v === 'number' && p.v > 0);
    if (!pts.length) return;
    const cur = pts[pts.length - 1], prev = pts[pts.length - 2];
    items[w.id] = { name: header[ci], unit: units[ci] || '', period: cur.ym, value: Math.round(cur.v * 100) / 100, prev: prev ? Math.round(prev.v * 100) / 100 : null, prevPeriod: prev ? prev.ym : null };
  });
  return items;
}

function createWorldBank(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const log = (opts && opts.log) || ((m) => console.log(m));
  let cache = null;

  async function locate() {
    try {
      const res = await fetchImpl(PAGE, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if (res.ok) { const link = findXlsxLink(await res.text()); if (link) return { url: link, from: 'page' }; }
    } catch (e) { /* 마지막으로 확인한 주소로 */ }
    return { url: KNOWN, from: 'known' };
  }

  async function load() {
    const loc = await locate();
    const res = await fetchImpl(loc.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new WbError(res.status, '세계은행 월간 가격 파일을 받지 못했습니다.');
    const buf = Buffer.from(await res.arrayBuffer());
    const items = parseMonthly(readSheet(buf, 'Monthly Prices'));
    return { loc, items, bytes: buf.length };
  }

  async function latest() {
    if (cache && cache.exp > Date.now()) return cache.value;
    const { loc, items } = await load();
    const period = Object.values(items).map(i => i.period).sort().pop() || null;
    log('worldbank period=' + period + ' items=' + Object.keys(items).length + ' from=' + loc.from);
    const value = { status: 'ok', source: SOURCE, fileUrl: loc.url, period, items, fetchedAt: new Date().toISOString() };
    cache = { value, exp: Date.now() + TTL_MS };
    return value;
  }

  async function probe() {
    const { loc, items, bytes } = await load();
    return { fileUrl: loc.url, linkFrom: loc.from, bytes, items, checkedAt: new Date().toISOString() };
  }

  return { latest, probe };
}

module.exports = { createWorldBank, parseMonthly, findXlsxLink, WbError };
