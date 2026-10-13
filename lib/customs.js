'use strict';
// 관세청 품목별 국가별 수출입실적(GW) — 공공데이터포털 15100475
// 인증키는 서버 환경변수 CUSTOMS_SERVICE_KEY(공공데이터포털의 'Decoding' 키)에서만 읽는다.
// 키가 들어간 URL은 로그·응답·오류 메시지에 넣지 않는다.

const BASE = process.env.CUSTOMS_API_BASE || 'https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList';
const SOURCE = { name: '관세청 품목별 국가별 수출입실적 (공공데이터포털)', url: 'https://www.data.go.kr/data/15100475/openapi.do' };

class CustomsConfigError extends Error {}
class CustomsUpstreamError extends Error {
  constructor(status, detail) { super('customs request failed (' + status + ')'); this.status = status; this.detail = detail || ''; }
}

function serviceKey() {
  const k = process.env.CUSTOMS_SERVICE_KEY;
  if (!k || !k.trim()) throw new CustomsConfigError('CUSTOMS_SERVICE_KEY is not set on the server');
  let v = k.trim();
  // 'Encoding' 키를 넣었으면 한 번 풀어서 쓴다(URLSearchParams가 다시 인코딩한다).
  if (/%[0-9A-Fa-f]{2}/.test(v)) { try { v = decodeURIComponent(v); } catch (e) { /* 그대로 사용 */ } }
  return v;
}
function redactStr(s) {
  const raw = process.env.CUSTOMS_SERVICE_KEY && process.env.CUSTOMS_SERVICE_KEY.trim();
  let out = String(s);
  if (raw) {
    [raw, (() => { try { return decodeURIComponent(raw); } catch (e) { return raw; } })(), encodeURIComponent(raw)]
      .forEach(k => { if (k) out = out.split(k).join('[redacted]'); });
  }
  return out;
}

// 아주 단순한 XML 파서: <item> 안의 1단계 태그만 읽는다(이 API 응답 구조에 충분).
function decodeEntities(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function tag(xml, name) { const m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>')); return m ? decodeEntities(m[1].trim()) : null; }
function parseXml(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const o = {};
    for (const f of m[1].matchAll(/<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = decodeEntities(f[2].trim());
    items.push(o);
  }
  return {
    resultCode: tag(xml, 'resultCode'),
    resultMsg: tag(xml, 'resultMsg'),
    // 게이트웨이 오류 형식: <OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>…
    authMsg: tag(xml, 'returnAuthMsg'),
    reasonCode: tag(xml, 'returnReasonCode'),
    totalCount: tag(xml, 'totalCount'),
    items
  };
}

async function query(params, fetchImpl) {
  const qs = new URLSearchParams(Object.assign({ serviceKey: serviceKey() }, params));
  const res = await fetchImpl(BASE + '?' + qs.toString(), { headers: { Accept: 'application/xml' } });
  const text = await res.text();
  if (!res.ok) throw new CustomsUpstreamError(res.status, redactStr(text.slice(0, 200)));
  const r = parseXml(text);
  if (r.authMsg) throw new CustomsUpstreamError('gateway-' + (r.reasonCode || '?'), redactStr(r.authMsg));
  if (r.resultCode && !/^0+$/.test(r.resultCode)) throw new CustomsUpstreamError('api-' + r.resultCode, redactStr(r.resultMsg || ''));
  return r;
}

function ym(d, back) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
  return x.getUTCFullYear() + String(x.getUTCMonth() + 1).padStart(2, '0');
}

function createCustoms(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const now = (opts && opts.now) || (() => new Date());
  const log = (opts && opts.log) || ((m) => console.log(m));

  // 진단: 국가 지정 여부·HS 자릿수에 따라 응답이 어떻게 오는지 확인한다.
  async function probe() {
    serviceKey();
    const start = ym(now(), 4), end = ym(now(), 1);
    const cases = [
      { label: '중국·HS 7208 (4자리)', params: { cntyCd: 'CN', hsSgn: '7208' } },
      { label: '중국·HS 720851 (6자리)', params: { cntyCd: 'CN', hsSgn: '720851' } },
      { label: '일본·HS 7208', params: { cntyCd: 'JP', hsSgn: '7208' } },
      { label: '호주·HS 2601 (철광석)', params: { cntyCd: 'AU', hsSgn: '2601' } },
      { label: '국가 생략·HS 7208', params: { hsSgn: '7208' } },
      { label: '국가 전체 코드 시도(ZZ)·HS 7208', params: { cntyCd: 'ZZ', hsSgn: '7208' } }
    ];
    const results = [];
    for (const c of cases) {
      try {
        const r = await query(Object.assign({ strtYymm: start, endYymm: end }, c.params), fetchImpl);
        results.push({ label: c.label, ok: true, resultCode: r.resultCode, resultMsg: r.resultMsg, totalCount: r.totalCount, count: r.items.length, items: r.items.slice(0, 12) });
      } catch (e) {
        results.push({ label: c.label, ok: false, status: String(e.status || e.name), message: e.detail || e.message });
        if (e instanceof CustomsConfigError) throw e;
      }
    }
    log('customs probe ok=' + results.filter(r => r.ok).length + '/' + results.length);
    return JSON.parse(redactStr(JSON.stringify({ source: SOURCE, period: { start, end }, results, checkedAt: new Date().toISOString() })));
  }

  return { probe };
}

module.exports = { createCustoms, parseXml, CustomsConfigError, CustomsUpstreamError, SOURCE, redactStr };
