'use strict';
// 한국수출입은행 현재환율 Open API — 영업일 매매기준율(deal_bas_r). 2025-06-25부터 oapi.koreaexim.go.kr.
// 인증키는 서버 환경변수 KOREAEXIM_API_KEY에서만 읽는다(수출입은행 사이트에서 발급, 공공데이터포털 키와 별개).
// 주말·공휴일·당일 오전 11시 이전에는 빈 배열이 온다 → 이전 날짜로 물러난다.

const BASE = process.env.KOREAEXIM_API_BASE || 'https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON';
const SOURCE = { name: '한국수출입은행 현재환율 (매매기준율)', url: 'https://www.koreaexim.go.kr' };
const WANT = { USD: 'USD', 'CNH': 'CNH', 'JPY(100)': 'JPY100' };
const DAYS_BACK = 10;

class EximConfigError extends Error {}
class EximUpstreamError extends Error {
  constructor(status, detail) { super('KEXIM request failed (' + status + ')'); this.status = status; this.detail = detail || ''; }
}

function apiKey() {
  const k = process.env.KOREAEXIM_API_KEY;
  if (!k || !k.trim()) throw new EximConfigError('KOREAEXIM_API_KEY is not set on the server');
  return k.trim();
}
function redactStr(s) {
  const k = process.env.KOREAEXIM_API_KEY && process.env.KOREAEXIM_API_KEY.trim();
  let out = String(s);
  if (k) [k, encodeURIComponent(k)].forEach(x => { out = out.split(x).join('[redacted]'); });
  return out;
}
function num(v) { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : null; }
// 한국 시간 기준 날짜
function kstDate(d) { return new Date(d.getTime() + 9 * 3600 * 1000); }
function ymd(d) { return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); }

// result: 1 성공, 2 DATA 코드 오류, 3 인증코드 오류, 4 일일 제한 횟수 마감
async function day(dateStr, fetchImpl) {
  const qs = new URLSearchParams({ authkey: apiKey(), searchdate: dateStr, data: 'AP01' });
  const res = await fetchImpl(BASE + '?' + qs.toString(), { headers: { Accept: 'application/json' }, redirect: 'follow' });
  const text = await res.text();
  if (!res.ok) throw new EximUpstreamError(res.status, redactStr(text.slice(0, 200)));
  let rows;
  try { rows = JSON.parse(text || '[]'); } catch (e) { throw new EximUpstreamError('invalid-json', redactStr(text.slice(0, 200))); }
  if (!Array.isArray(rows)) rows = [];
  const bad = rows.find(r => r && r.result != null && Number(r.result) !== 1);
  if (bad) throw new EximUpstreamError('result-' + bad.result, { 2: 'DATA 코드 오류', 3: '인증코드 오류', 4: '일일 제한 횟수 마감' }[Number(bad.result)] || '');
  const rates = {};
  rows.forEach(r => { const k = WANT[String(r.cur_unit || '').trim()]; const v = num(r.deal_bas_r); if (k && v) rates[k] = v; });
  return { date: dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6), rates, count: rows.length };
}

function createEximFx(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const now = (opts && opts.now) || (() => new Date());
  const cache = new Map();

  async function cachedDay(dateStr, isToday) {
    const hit = cache.get(dateStr);
    if (hit && hit.exp > Date.now()) return hit.value;
    const v = await day(dateStr, fetchImpl);
    // 오늘 값은 오전 11시 이후 생기므로 짧게, 지난 날짜는 길게 저장
    cache.set(dateStr, { value: v, exp: Date.now() + (isToday ? 30 * 60 * 1000 : 24 * 3600 * 1000) });
    return v;
  }
  const has = d => d && d.rates && d.rates.USD > 0;

  // 가장 최근 영업일과 그 전 영업일
  async function latest() {
    apiKey();
    const base = kstDate(now());
    const found = [];
    for (let i = 0; i <= DAYS_BACK && found.length < 2; i++) {
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - i));
      const wd = d.getUTCDay();
      if (wd === 0 || wd === 6) continue; // 주말은 묻지 않는다
      const v = await cachedDay(ymd(d), i === 0);
      if (has(v)) found.push(v);
    }
    if (!found.length) return { status: 'nodata', source: SOURCE };
    return { status: 'ok', source: SOURCE, date: found[0].date, rates: found[0].rates, prevDate: found[1] ? found[1].date : null, prevRates: found[1] ? found[1].rates : null, fetchedAt: new Date().toISOString() };
  }

  // 진단: 최근 며칠의 결과 코드·행 수·필요한 통화 값
  async function probe() {
    apiKey();
    const base = kstDate(now());
    const out = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - i));
      try { const v = await day(ymd(d), fetchImpl); out.push({ date: v.date, ok: true, count: v.count, rates: v.rates }); }
      catch (e) { if (e instanceof EximConfigError) throw e; out.push({ date: ymd(d), ok: false, status: String(e.status || e.name), message: redactStr(e.detail || e.message), cause: e.cause ? String(e.cause.code || e.cause.message || '') : undefined }); }
    }
    return { endpoint: 'oapi.koreaexim.go.kr', region: process.env.VERCEL_REGION || 'local', results: out, checkedAt: new Date().toISOString() };
  }

  return { latest, probe };
}

module.exports = { createEximFx, EximConfigError, EximUpstreamError, SOURCE };
