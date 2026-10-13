'use strict';
// 미국 노동통계국(BLS) Public Data API v2 — 생산자물가지수(PPI, 1982=100). 퍼블릭 도메인.
// 인증키는 서버 환경변수 BLS_API_KEY에서만 읽는다(요청 본문에 넣고, 응답·로그에는 넣지 않는다).

const BASE = process.env.BLS_API_BASE || 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const SOURCE = { name: 'U.S. Bureau of Labor Statistics, Producer Price Index', url: 'https://www.bls.gov/ppi/' };
// gl2(냉연)는 코드가 확실하지 않아 후보들의 공식 제목에서 'cold rolled'를 찾아 고른다.
const SERIES = [
  { id: 'gl1', candidates: ['WPU1017'], match: /steel mill products/i },
  { id: 'gl2', candidates: ['WPU101703', 'WPU10170301', 'WPU101704', 'WPU10170401', 'WPU101705', 'WPU101706', 'WPU101707'], match: /cold[\s-]*rolled/i, prefer: /sheet|strip/i },
  { id: 'gl3', candidates: ['WPU1012'], match: /scrap/i }
];
const TTL_MS = 12 * 60 * 60 * 1000;

class BlsConfigError extends Error {}
class BlsUpstreamError extends Error {
  constructor(status, detail) { super('BLS request failed (' + status + ')'); this.status = status; this.detail = detail || ''; }
}
function apiKey() {
  const k = process.env.BLS_API_KEY;
  if (!k || !k.trim()) throw new BlsConfigError('BLS_API_KEY is not set on the server');
  return k.trim();
}
function redactStr(s) { const k = process.env.BLS_API_KEY && process.env.BLS_API_KEY.trim(); return k ? String(s).split(k).join('[redacted]') : String(s); }

async function fetchSeries(ids, fetchImpl, now) {
  const y = now().getUTCFullYear();
  const res = await fetchImpl(BASE, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ seriesid: ids, startyear: String(y - 1), endyear: String(y), registrationkey: apiKey(), catalog: true })
  });
  const text = await res.text();
  if (!res.ok) throw new BlsUpstreamError(res.status, redactStr(text.slice(0, 200)));
  let body; try { body = JSON.parse(text); } catch (e) { throw new BlsUpstreamError('invalid-json'); }
  if (body.status !== 'REQUEST_SUCCEEDED') throw new BlsUpstreamError(String(body.status || 'failed'), redactStr((body.message || []).join(' / ')));
  return { series: (body.Results && body.Results.series) || [], messages: (body.message || []).map(redactStr) };
}

// 월별 값만(M01~M12), 최신순
function monthly(s) {
  return (s.data || []).filter(d => /^M(0[1-9]|1[0-2])$/.test(d.period) && d.value !== '-' && d.value !== '')
    .map(d => ({ ym: d.year + '-' + d.period.slice(1), value: Number(d.value), preliminary: (d.footnotes || []).some(f => f && f.code === 'P') }))
    .sort((a, b) => b.ym.localeCompare(a.ym));
}
const title = s => String((s.catalog && s.catalog.series_title) || '');

function choose(def, list) {
  const got = list.filter(s => def.candidates.includes(s.seriesID) && monthly(s).length && def.match.test(title(s)));
  if (def.prefer) got.sort((a, b) => Number(def.prefer.test(title(b))) - Number(def.prefer.test(title(a))) || def.candidates.indexOf(a.seriesID) - def.candidates.indexOf(b.seriesID));
  return got[0] || null;
}

function createBls(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const now = (opts && opts.now) || (() => new Date());
  const log = (opts && opts.log) || ((m) => console.log(m));
  let cache = null;
  const allIds = [...new Set(SERIES.flatMap(s => s.candidates))];

  async function latest() {
    apiKey();
    if (cache && cache.exp > Date.now()) return cache.value;
    const { series } = await fetchSeries(allIds, fetchImpl, now);
    const items = SERIES.map(def => {
      const s = choose(def, series);
      if (!s) return { id: def.id, status: 'nodata' };
      const m = monthly(s);
      const cur = m[0], prev = m.find(x => x.ym < cur.ym);
      return { id: def.id, status: 'ok', seriesId: s.seriesID, title: title(s), period: cur.ym, value: cur.value, preliminary: cur.preliminary,
        prev: prev ? prev.value : null, change: prev ? Math.round((cur.value - prev.value) * 1000) / 1000 : null };
    });
    log('bls ppi ok=' + items.filter(i => i.status === 'ok').length + '/' + items.length);
    const value = { status: 'ok', source: SOURCE, items, fetchedAt: new Date().toISOString() };
    cache = { value, exp: Date.now() + TTL_MS };
    return value;
  }

  async function probe() {
    apiKey();
    const { series, messages } = await fetchSeries(allIds, fetchImpl, now);
    return { messages, series: series.map(s => { const m = monthly(s); return { seriesId: s.seriesID, title: title(s), latest: m[0] || null, points: m.length }; }), checkedAt: new Date().toISOString() };
  }

  return { latest, probe };
}

module.exports = { createBls, BlsConfigError, BlsUpstreamError, SERIES, monthly };
