'use strict';
// GET /api/fx        → 최신 주간 과세환율 + 최근 3개월 월평균
// GET /api/fx-probe  → 요청 형식별 원 응답 일부 (진단용)
// 인증키는 응답·로그에 넣지 않는다.
const { createFx } = require('./fx');
const { query, CustomsConfigError, CustomsUpstreamError, redactStr } = require('./customs');

function monthsBack(d, n) { const out = []; for (let i = 1; i <= n; i++) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0')); } return out; }

function errorSend(e, send, logger) {
  if (e instanceof CustomsConfigError) { logger('fx config error: key missing'); return send(503, { error: 'not_configured', message: '서버에 CUSTOMS_SERVICE_KEY가 설정되지 않았습니다.' }); }
  if (e instanceof CustomsUpstreamError) { logger('fx upstream error status=' + e.status); return send(502, { error: 'upstream', status: String(e.status), message: e.detail || '관세청 환율 API 응답 오류' }); }
  logger('fx unexpected error type=' + (e && e.name));
  send(500, { error: 'internal' });
}

function makeFxHandler(service, log, now) {
  const svc = service || createFx();
  const logger = log || ((m) => console.error(m));
  const clock = now || (() => new Date());
  return async function handle(send) {
    try {
      const latest = await svc.latest();
      const months = [];
      for (const ym of monthsBack(clock(), 3)) { const a = await svc.monthAvg(ym); if (a) months.push(a); }
      send(200, Object.assign({}, latest, { monthly: months, fetchedAt: new Date().toISOString() }), 'public, max-age=600');
    } catch (e) { errorSend(e, send, logger); }
  };
}

function makeFxProbeHandler(fetchImpl, log, now) {
  const f = fetchImpl || globalThis.fetch;
  const logger = log || ((m) => console.error(m));
  const clock = now || (() => new Date());
  const BASE = 'https://apis.data.go.kr/1220000/retrieveTrifFxrtInfo/getRetrieveTrifFxrtInfo';
  return async function handle(send) {
    const d = clock();
    const ymd = x => x.getUTCFullYear() + String(x.getUTCMonth() + 1).padStart(2, '0') + String(x.getUTCDate()).padStart(2, '0');
    const sun = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()));
    const cases = [
      { label: '이번 주 일요일·수입', p: { aplyBgnDt: ymd(sun), weekFxrtTpcd: '2' } },
      { label: '오늘 날짜·수입', p: { aplyBgnDt: ymd(d), weekFxrtTpcd: '2' } },
      { label: '지난주 일요일·수출', p: { aplyBgnDt: ymd(new Date(sun.getTime() - 7 * 864e5)), weekFxrtTpcd: '1' } }
    ];
    const results = [];
    try {
      for (const c of cases) {
        try {
          const r = await query(c.p, f, BASE);
          const want = r.items.filter(it => /USD|CNY|JPY|EUR/.test(String(it.currSgn || '')));
          results.push({ label: c.label, params: c.p, ok: true, count: r.items.length, sample: (want.length ? want : r.items).slice(0, 6) });
        } catch (e) {
          if (e instanceof CustomsConfigError) throw e;
          results.push({ label: c.label, params: c.p, ok: false, status: String(e.status || e.name), message: e.detail || e.message });
        }
      }
      send(200, JSON.parse(redactStr(JSON.stringify({ results, checkedAt: new Date().toISOString() }))), null);
    } catch (e) { errorSend(e, send, logger); }
  };
}

module.exports = { makeFxHandler, makeFxProbeHandler };
