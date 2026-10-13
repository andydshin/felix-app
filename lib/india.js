'use strict';
// 인도 상공부 경제자문관실(OEA) 도매물가지수(WPI, 2022-23=100) 품목별 월간 지수 — eaindustry.nic.in, 키 없음.
// 매달 14일 발표. 파일 이름에 기준 월이 붙어(wpi_monthly_index_YYYYMM.xlsx) 다운로드 페이지에서 링크를 찾는다.
// 표 구조·품목 이름은 파일을 열어 확인한다(진단 주소로 먼저 본다).
const { readSheet, sheetNames } = require('./xlsx-lite');

const PAGE = 'https://eaindustry.nic.in/download_data_2223.asp';
const SOURCE = { name: 'Office of the Economic Adviser, DPIIT, Government of India — Wholesale Price Index (2022-23=100)', url: 'https://eaindustry.nic.in' };
const UA = 'Mozilla/5.0 (compatible; FelixDataBot/1.0; steel price research)';
const TTL_MS = 12 * 60 * 60 * 1000;
// 국가 비교 표 칸 ↔ WPI 품목 이름 패턴(앞쪽 우선). 진단 결과를 보고 확정한다.
const MAP = [
  { id: 'hr', re: [/\bH\.?R\.?\s*coil/i, /hot[\s-]*rolled.*(coil|sheet)/i] },
  { id: 'cr', re: [/\bC\.?R\.?\s*coil/i, /cold[\s-]*rolled.*(coil|sheet)/i] },
  { id: 'coated', re: [/\bG\.?P\.?\b|\bG\.?C\.?\b.*sheet/i, /galvani[sz]ed/i, /coated/i] },
  { id: 'plate', re: [/plate/i] },
  { id: 'wire_rod', re: [/wire\s*rod/i] },
  { id: 'rebar', re: [/\bbars?\b.*\brods?\b/i, /TMT|rebar|reinforc/i] },
  { id: 'section', re: [/angle|channel|structural|section/i] },
  { id: 'pipe', re: [/pipes?\b|tubes?\b/i] },
  { id: 'sts', re: [/stainless.*(coil|sheet|strip|flat)/i] },
  { id: 'iron_ore', re: [/iron\s*ore/i] },
  { id: 'coking_coal', re: [/^coking\s*coal/i, /\bcoking\s*coal/i] },
  { id: 'coke', re: [/^coke\b|metallurgical\s*coke|\bcoke\b(?!.*coal)/i] },
  { id: 'scrap', re: [/scrap/i] },
  { id: 'steam_coal', re: [/non[\s-]*coking\s*coal|steam\s*coal/i] },
  { id: 'al', re: [/alumin(i)?um\s*(ingot|primary|metal)/i, /^alumin(i)?um\b/i] },
  { id: 'cu', re: [/copper\s*(cathode|metal|ingot)/i, /^copper\b/i] },
  { id: 'zn', re: [/^zinc\b/i, /zinc\s*(ingot|metal)/i] },
  { id: 'ni', re: [/nickel/i] },
  { id: 'pb', re: [/^lead\b/i, /lead\s*(ingot|metal)/i] }
];

class IndiaError extends Error { constructor(status, detail) { super('India WPI failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }

function findLink(html) {
  const all = [...html.matchAll(/href=["']([^"']*wpi_monthly_index_(\d{6})\.xlsx)["']/gi)].map(m => ({ href: m[1], ym: m[2] }));
  all.sort((a, b) => b.ym.localeCompare(a.ym));
  return all[0] ? new URL(all[0].href, PAGE).toString() : null;
}

// 월 머리글: 'INDX092026', 'Sep-2026', '2026-09', 엑셀 날짜 숫자 등 → 'YYYY-MM'
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function monthOf(h) {
  if (h == null) return null;
  if (typeof h === 'number' && h > 30000 && h < 60000) { const d = new Date(Date.UTC(1899, 11, 30) + h * 864e5); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  const s = String(h).trim();
  let m = s.match(/INDX\s*(\d{2})(\d{4})/i); if (m) return m[2] + '-' + m[1];
  m = s.match(/^(\d{4})[-/ ](\d{1,2})$/); if (m) return m[1] + '-' + m[2].padStart(2, '0');
  m = s.match(/^([A-Za-z]{3})[a-z]*[-' ]*(\d{2,4})$/); if (m && MON[m[1].toLowerCase()]) { const y = m[2].length === 2 ? '20' + m[2] : m[2]; return y + '-' + String(MON[m[1].toLowerCase()]).padStart(2, '0'); }
  return null;
}

function analyze(rows) {
  // 머리글 행: 월 열이 3개 이상인 첫 행
  let hi = -1, months = [];
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i] ? Array.from(rows[i]) : [];
    const ms = r.map((v, c) => ({ c, ym: monthOf(v) })).filter(x => x.ym);
    if (ms.length >= 3) { hi = i; months = ms; break; }
  }
  if (hi < 0) return { header: null, items: [] };
  const header = Array.from(rows[hi], v => (v == null ? '' : String(v)));
  // 이름 열: 머리글에 NAME/Commodit/Item이 있는 열, 없으면 첫 텍스트 열
  let nameCol = header.findIndex(h => /name|commodit|item|description/i.test(h));
  if (nameCol < 0) nameCol = 0;
  const codeCol = header.findIndex(h => /code/i.test(h));
  const items = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const name = r[nameCol]; if (typeof name !== 'string' || !name.trim()) continue;
    const series = months.map(m => ({ ym: m.ym, v: typeof r[m.c] === 'number' ? r[m.c] : Number(r[m.c]) })).filter(p => Number.isFinite(p.v) && p.v > 0).sort((a, b) => a.ym.localeCompare(b.ym));
    items.push({ name: name.trim(), code: codeCol >= 0 && r[codeCol] != null ? String(r[codeCol]) : '', series });
  }
  return { header: header.slice(0, 8).concat(header.length > 8 ? ['…' + header[header.length - 1]] : []), headerRow: hi + 1, nameCol, items };
}

function pick(items) {
  const out = {};
  MAP.forEach(m => {
    for (const re of m.re) {
      const c = items.filter(it => re.test(it.name) && it.series.length).sort((a, b) => a.name.length - b.name.length);
      if (c.length) { const it = c[0], s = it.series, cur = s[s.length - 1], prev = s[s.length - 2]; out[m.id] = { name: it.name, code: it.code, period: cur.ym, value: Math.round(cur.v * 10) / 10, prev: prev ? Math.round(prev.v * 10) / 10 : null }; break; }
    }
  });
  return out;
}

function createIndia(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const log = (opts && opts.log) || ((m) => console.log(m));
  let cache = null;

  async function load() {
    const res = await fetchImpl(PAGE, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!res.ok) throw new IndiaError(res.status, '다운로드 페이지를 열지 못했습니다.');
    const url = findLink(await res.text());
    if (!url) throw new IndiaError('no-link', 'WPI 월간 파일 링크를 찾지 못했습니다.');
    const f = await fetchImpl(url, { headers: { 'User-Agent': UA } });
    if (!f.ok) throw new IndiaError(f.status, 'WPI 파일을 받지 못했습니다.');
    const buf = Buffer.from(await f.arrayBuffer());
    const names = sheetNames(buf);
    const a = analyze(readSheet(buf, null));
    return { url, bytes: buf.length, sheets: names, a };
  }

  async function latest() {
    if (cache && cache.exp > Date.now()) return cache.value;
    const { url, a } = await load();
    const items = pick(a.items);
    if (!Object.keys(items).length) throw new IndiaError('parse', '철강 품목을 찾지 못했습니다.');
    const period = Object.values(items).map(i => i.period).sort().pop();
    log('india wpi period=' + period + ' items=' + Object.keys(items).length);
    const value = { status: 'ok', source: SOURCE, fileUrl: url, period, items, fetchedAt: new Date().toISOString() };
    cache = { value, exp: Date.now() + TTL_MS };
    return value;
  }

  // 진단: 파일·시트·머리글, 고른 품목, 철강·원료·비철 관련 이름 후보
  async function probe() {
    const { url, bytes, sheets, a } = await load();
    const KW = /steel|iron|coil|sheet|plate|rod|bar|pipe|tube|angle|channel|stainless|galvan|coke|coal|scrap|alumin|copper|zinc|nickel|lead|sponge|pig/i;
    return {
      fileUrl: url, bytes, sheets, headerRow: a.headerRow, header: a.header, itemCount: a.items.length,
      picked: pick(a.items),
      candidates: a.items.filter(it => KW.test(it.name)).slice(0, 80).map(it => it.name + (it.series.length ? ' = ' + it.series[it.series.length - 1].v + ' (' + it.series[it.series.length - 1].ym + ')' : '')),
      checkedAt: new Date().toISOString()
    };
  }

  return { latest, probe };
}

module.exports = { createIndia, analyze, pick, findLink, monthOf, IndiaError };
