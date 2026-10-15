'use strict';
// HS 코드 무역 검색: "어느 시장이(수입국) 어느 나라에서(상대국) 이 품목을 얼마나, 얼마에 들여오나"
//  ① UN Comtrade (수입국이 신고한 월별 통계, CIF) — 멕시코·미국·베트남 등 아무 나라나. 키: 환경변수 COMTRADE_API_KEY
//     키가 없으면 공개 미리보기 API(건수 제한)로 시도한다.
//  ② 관세청 품목별 국가별 수출입실적 — 한국 기준(한국→상대국 수출 FOB, 상대국→한국 수입 CIF). 키: CUSTOMS_SERVICE_KEY
// 키는 서버 환경변수에서만 읽고, 응답·로그에는 넣지 않는다.
const { query: customsQuery } = require('./customs');

const COMTRADE = process.env.COMTRADE_BASE || 'https://comtradeapi.un.org';
// ISO2 → UN M49
const M49 = { WD: 0, CN: 156, KR: 410, JP: 392, US: 842, MX: 484, VN: 704, IN: 699, TW: 490, DE: 276, ID: 360, TH: 764, BR: 76, CA: 124, TR: 792, MY: 458 };
const NAME = { WD: '전체', CN: '중국', KR: '한국', JP: '일본', US: '미국', MX: '멕시코', VN: '베트남', IN: '인도', TW: '대만', DE: '독일', ID: '인도네시아', TH: '태국', BR: '브라질', CA: '캐나다', TR: '튀르키예', MY: '말레이시아' };
const PRESETS = {
  tinplate: { name: '석도강판', codes: ['721011', '721012', '721210'], note: '7210.11 두께 0.5mm 이상 · 7210.12 0.5mm 미만 · 7212.10 폭 600mm 미만' },
  hr: { name: '열연', codes: ['7208'] }, cr: { name: '냉연', codes: ['7209'] }, coated: { name: '도금강판', codes: ['721049', '721041', '721070'] },
  plate: { name: '후판', codes: ['720851', '720852'] }, rebar: { name: '철근', codes: ['721420'] }, sts: { name: '스테인리스 판재', codes: ['7219'] }
};
const TTL = 12 * 3600;

class HsError extends Error { constructor(status, detail) { super('hs trade failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }
const codesOf = s => [...new Set(String(s || '').split(/[\s,]+/).map(x => x.replace(/\D/g, '')).filter(x => x.length >= 4 && x.length <= 10))].slice(0, 6);
const iso = s => [...new Set(String(s || '').toUpperCase().split(/[\s,]+/).filter(x => x in M49))].slice(0, 6);
function monthsBack(now, n, skip) { const out = []; for (let i = n + (skip || 0) - 1; i >= (skip || 0); i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); out.push(d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0')); } return out; }
const ymDash = p => String(p).slice(0, 4) + '-' + String(p).slice(4, 6);
function redact(s) { const k = process.env.COMTRADE_API_KEY; return k ? String(s).split(k.trim()).join('[redacted]') : String(s); }

// 행 [{ym, code, partner, kg, usd}] → { months, series: { partner: { total: [{ym,t,usd,unit}], byCode: {code: [...]}}}, latest }
function shape(rows, partners, codes) {
  const months = [...new Set(rows.map(r => r.ym))].sort();
  const series = {};
  const pt = (list, ym) => { const a = list.filter(r => r.ym === ym); const kg = a.reduce((s, r) => s + r.kg, 0), usd = a.reduce((s, r) => s + r.usd, 0); return kg > 0 ? { ym, t: Math.round(kg / 100) / 10, usd: Math.round(usd), unit: Math.round(usd / (kg / 1000) * 10) / 10 } : { ym, t: 0, usd: Math.round(usd), unit: null }; };
  partners.forEach(p => {
    const mine = rows.filter(r => r.partner === p);
    series[p] = { name: NAME[p] || p, total: months.map(m => pt(mine, m)), byCode: {} };
    codes.forEach(c => { series[p].byCode[c] = months.map(m => pt(mine.filter(r => r.code.startsWith(c)), m)); });
  });
  // 상대국 합계 대비 비중(전체 WD를 요청한 경우)
  return { months: months.map(ymDash), series };
}

function createHsTrade(opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || globalThis.fetch;
  const now = o.now || (() => new Date());
  const kv = o.kv || null;

  async function getJson(url, headers) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl && setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetchImpl(url, { headers: Object.assign({ Accept: 'application/json' }, headers || {}), signal: ctl ? ctl.signal : undefined });
      const text = await res.text();
      if (!res.ok) throw new HsError(res.status, redact(text.slice(0, 300)));
      try { return JSON.parse(text); } catch (e) { throw new HsError('invalid-json', redact(text.slice(0, 200))); }
    } catch (e) { if (e instanceof HsError) throw e; throw new HsError(e.name === 'AbortError' ? 'timeout' : 'network', String(e.cause && e.cause.code || e.message)); }
    finally { if (t) clearTimeout(t); }
  }

  // ① Comtrade: reporter의 수입(M) 또는 수출(X)
  async function comtrade(reporter, partners, codes, flow, nMonths) {
    const key = process.env.COMTRADE_API_KEY && process.env.COMTRADE_API_KEY.trim();
    const periods = monthsBack(now(), nMonths || 12, 1);
    const call = async ps => {
      const params = new URLSearchParams({ reporterCode: String(M49[reporter]), period: ps.join(','), partnerCode: partners.map(p => M49[p]).join(','), cmdCode: codes.join(','), flowCode: flow === 'export' ? 'X' : 'M', partner2Code: '0', customsCode: 'C00', motCode: '0', includeDesc: 'false' });
      const j = await getJson(COMTRADE + (key ? '/data/v1/get/C/M/HS?' : '/public/v1/preview/C/M/HS?') + params.toString(), key ? { 'Ocp-Apim-Subscription-Key': key } : null);
      if (j.error) throw new HsError('api', redact(JSON.stringify(j.error).slice(0, 200)));
      return j.data || [];
    };
    // 키가 있으면 한 번에, 거절되거나 키가 없으면(미리보기는 1회 1개월) 달마다 나눠 묻는다. 최신 달부터, 3개씩 동시에.
    let data = [], perMonth = !key, failed = [];
    if (key) { try { data = await call(periods); } catch (e) { if (String(e.status) === '400') perMonth = true; else throw e; } }
    if (perMonth) {
      const list = periods.slice().reverse();
      for (let i = 0; i < list.length; i += 3) {
        const got = await Promise.allSettled(list.slice(i, i + 3).map(p => call([p])));
        got.forEach((g, k) => { if (g.status === 'fulfilled') data.push(...g.value); else failed.push({ period: list[i + k], status: String(g.reason && g.reason.status) }); });
        if (failed.some(f => f.status === '429')) break; // 한도 초과면 멈춘다
      }
      if (!data.length && failed.length) throw new HsError(failed[0].status, '월별 조회가 모두 실패했습니다.');
    }
    const back = {}; Object.keys(M49).forEach(k => { back[M49[k]] = k; });
    const rows = data.map(r => {
      const kg = Number(r.netWgt) || (/kg/i.test(r.qtyUnitAbbr || '') ? Number(r.qty) : 0) || 0;
      return { ym: String(r.period), code: String(r.cmdCode), partner: back[r.partnerCode] || String(r.partnerCode), kg, usd: Number(r.primaryValue) || Number(flow === 'export' ? r.fobvalue : r.cifvalue) || 0 };
    }).filter(r => r.partner);
    return { source: 'UN Comtrade (' + (NAME[reporter] || reporter) + ' 신고, ' + (flow === 'export' ? 'FOB' : 'CIF') + ')', keyed: !!key, count: rows.length, rowsRaw: data.length, failed, rows };
  }

  // ② 관세청: 한국 → 상대국 수출(export) 또는 상대국 → 한국 수입(import)
  async function korea(partner, codes, flow, nMonths) {
    const ps = monthsBack(now(), nMonths || 12, 1);
    const rows = [];
    for (const c of codes) {
      const r = await customsQuery({ strtYymm: ps[0], endYymm: ps[ps.length - 1], hsSgn: c, cntyCd: partner }, fetchImpl);
      r.items.forEach(x => {
        const m = String(x.year || '').match(/^(\d{4})\.(\d{2})$/); if (!m) return;
        if (x.hsCd && !String(x.hsCd).startsWith(c)) return;
        rows.push({ ym: m[1] + m[2], code: String(x.hsCd || c), partner: 'KR', kg: Number(String(flow === 'export' ? x.expWgt : x.impWgt).replace(/,/g, '')) || 0, usd: Number(String(flow === 'export' ? x.expDlr : x.impDlr).replace(/,/g, '')) || 0 });
      });
    }
    return { source: '관세청 (한국 신고, ' + (flow === 'export' ? '수출 FOB' : '수입 CIF') + ')', count: rows.length, rows };
  }

  async function cached(k, fn) {
    if (kv) { try { const c = await kv.get(k); if (c && c.exp > Date.now()) return Object.assign({ cache: 'hit' }, c.v); } catch (e) { /* 저장소 오류는 무시 */ } }
    const v = await fn();
    if (kv) { try { await kv.set(k, { v, exp: Date.now() + TTL * 1000 }); } catch (e) { /* 무시 */ } }
    return v;
  }

  // 검색: market(수입국) · partners(상대국) · codes
  async function search(q) {
    const preset = PRESETS[q.preset];
    const codes = codesOf(q.codes) .length ? codesOf(q.codes) : (preset ? preset.codes : []);
    const market = iso(q.market)[0] || 'MX';
    const partners = iso(q.partners).length ? iso(q.partners) : ['CN', 'KR'];
    if (!codes.length) throw new HsError('bad_codes', 'HS 코드를 4~10자리 숫자로 넣으세요.');
    const ck = 'hs:v1:' + market + ':' + partners.join('.') + ':' + codes.join('.');
    return cached(ck, async () => {
      const out = { status: 'ok', market, marketName: NAME[market], partners: partners.map(p => ({ code: p, name: NAME[p] })), codes, preset: preset ? { name: preset.name, note: preset.note } : null, fetchedAt: new Date().toISOString() };
      if (market === 'KR') {
        // 한국 수입: 관세청이 가장 빠르고 정확
        const all = [];
        for (const p of partners.filter(p => p !== 'WD')) { const r = await korea(p, codes, 'import', 12); r.rows.forEach(x => { x.partner = p; }); all.push(...r.rows); }
        out.main = Object.assign({ source: '관세청 (한국 수입 신고, CIF)' }, shape(all, partners.filter(p => p !== 'WD'), codes));
      } else {
        const reqP = [...new Set(partners.filter(p => p !== market).concat(['WD']))];
        const [ct, kr] = await Promise.allSettled([comtrade(market, reqP, codes, 'import', 12), partners.includes('KR') ? korea(market, codes, 'export', 12) : Promise.resolve(null)]);
        if (ct.status === 'fulfilled') out.main = Object.assign({ source: ct.value.source, keyed: ct.value.keyed }, shape(ct.value.rows, reqP, codes));
        else out.mainError = { status: String(ct.reason && ct.reason.status), message: ct.reason && ct.reason.detail };
        if (kr.status === 'fulfilled' && kr.value) out.koreaExport = Object.assign({ source: kr.value.source }, shape(kr.value.rows, ['KR'], codes));
        else if (kr.status === 'rejected') out.koreaError = { status: String(kr.reason && kr.reason.status), message: String(kr.reason && (kr.reason.detail || kr.reason.message) || '') };
      }
      return out;
    });
  }

  // 진단: 응답 구조와 건수
  async function probe() {
    const out = { checkedAt: new Date().toISOString(), comtradeKey: !!process.env.COMTRADE_API_KEY, customsKey: !!process.env.CUSTOMS_SERVICE_KEY };
    try { const r = await comtrade('MX', ['CN', 'KR'], ['721012', '721011', '721210'], 'import', 12); out.comtrade = { ok: true, keyed: r.keyed, rowsRaw: r.rowsRaw, failed: r.failed, months: [...new Set(r.rows.map(x => x.ym))].sort(), sample: r.rows.slice(0, 4) }; }
    catch (e) { out.comtrade = { ok: false, status: String(e.status), detail: e.detail }; }
    try { const r = await korea('MX', ['721012', '721011', '721210'], 'export', 12); out.korea = { ok: true, rows: r.count, months: [...new Set(r.rows.map(x => x.ym))].sort(), sample: r.rows.slice(0, 4) }; }
    catch (e) { out.korea = { ok: false, status: String(e.status || e.name), detail: String(e.detail || e.message || '') }; }
    return out;
  }

  return { search, probe, comtrade, korea };
}

module.exports = { createHsTrade, shape, codesOf, PRESETS, NAME, M49, HsError };
