'use strict';
// 관세청 관세환율정보(GW): 세관이 주 단위로 고시하는 과세환율(원화 기준). 공공데이터포털 15101600번대, 이용허락범위 제한 없음.
// 인증키는 관세청 수출입실적과 같은 CUSTOMS_SERVICE_KEY를 쓴다.
const { query, serviceKey } = require('./customs');

const FX_BASE = process.env.CUSTOMS_FX_BASE || 'https://apis.data.go.kr/1220000/retrieveTrifFxrtInfo/getRetrieveTrifFxrtInfo';
const IMPORT = '2'; // weekFxrtTpcd: 1 수출, 2 수입 (수입 통관 단가와 맞춘다)
const CURRENCIES = ['USD', 'CNY', 'JPY'];
const TTL_MS = 12 * 60 * 60 * 1000;
const SOURCE = { name: '관세청 관세환율정보 (공공데이터포털)', note: '세관 고시 주간 과세환율(수입)' };

function ymd(d) { return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); }
// 과세환율은 일요일부터 토요일까지 적용된다. 기술문서 예제: aplyBgnDt=20150101(목) → 적용개시일자 20141228(일). 그래도 일요일로 맞춰 묻는다.
function sundayOf(d) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x; }
function num(v) { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; }

// 응답 행 → { USD: 원/달러, CNY: 원/위안, JPY100: 원/100엔 }
function pick(items) {
  const out = {};
  items.forEach(it => {
    const cur = String(it.currSgn || '').trim().toUpperCase();
    if (!CURRENCIES.includes(cur)) return;
    const v = num(it.fxrt);
    if (!(v > 0)) return;
    // 엔화: 기술문서에 단위가 없다. 화폐단위명에 100이 있거나 값이 50 이상이면 100엔 기준, 아니면 1엔 기준으로 보고 100엔으로 맞춘다.
    if (cur === 'JPY') out.JPY100 = (/100/.test(String(it.mtryUtNm || '')) || v >= 50) ? v : Math.round(v * 100 * 100) / 100;
    else out[cur] = v;
  });
  return out;
}

function createFx(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const now = (opts && opts.now) || (() => new Date());
  const cache = new Map();

  async function week(sunday) {
    const key = ymd(sunday);
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const r = await query({ aplyBgnDt: key, weekFxrtTpcd: IMPORT }, fetchImpl, FX_BASE);
    const value = { week: key.slice(0, 4) + '-' + key.slice(4, 6) + '-' + key.slice(6), rates: pick(r.items) };
    cache.set(key, { value, exp: Date.now() + TTL_MS });
    return value;
  }
  const has = w => w && w.rates && w.rates.USD > 0;

  // 이번 주 고시가 없으면 지난주로 물러난다(최대 3주).
  async function latest() {
    serviceKey();
    let s = sundayOf(now());
    let cur = null;
    for (let i = 0; i < 4 && !has(cur); i++) { cur = await week(s); if (!has(cur)) s = new Date(s.getTime() - 7 * 864e5); }
    if (!has(cur)) return { status: 'nodata', source: SOURCE };
    const prev = await week(new Date(s.getTime() - 7 * 864e5));
    return { status: 'ok', source: SOURCE, week: cur.week, rates: cur.rates, prevWeek: has(prev) ? prev.week : null, prevRates: has(prev) ? prev.rates : null };
  }

  // 월평균: 그 달에 시작하는 주들의 과세환율 평균
  async function monthAvg(ym) {
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    let s = sundayOf(first);
    if (s.getUTCMonth() !== m - 1) s = new Date(s.getTime() + 7 * 864e5);
    const weeks = [];
    while (s.getUTCMonth() === m - 1 && s.getTime() <= now().getTime()) { const w = await week(s); if (has(w)) weeks.push(w.rates); s = new Date(s.getTime() + 7 * 864e5); }
    if (!weeks.length) return null;
    const avg = k => { const v = weeks.map(w => w[k]).filter(x => x > 0); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) / 100 : null; };
    return { month: ym, weeks: weeks.length, USD: avg('USD'), CNY: avg('CNY'), JPY100: avg('JPY100') };
  }

  return { latest, monthAvg, week };
}

module.exports = { createFx, pick, sundayOf, SOURCE };
