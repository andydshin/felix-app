'use strict';
// 멕시코 INEGI 지표 API(Banco de Indicadores) — 생산자물가지수(INPP) 품목별. 토큰은 서버 환경변수 INEGI_TOKEN에서만 읽는다.
// 이용 조건: 상업적 이용 허용, "Fuente: INEGI" 출처 표시, 가공 사실 고지, INEGI 보증처럼 보이지 않게.
// 지표 번호(IdIndicador)를 아직 모르므로 진단에서 BIE 지표 목록(CL_INDICATOR)을 받아 철강 관련 이름을 찾는다.

const BASE = process.env.INEGI_API_BASE || 'https://www.inegi.org.mx/app/api/indicadores/desarrolladores/jsonxml';
const SOURCE = { name: 'INEGI, Índice Nacional de Precios Productor (base julio 2019=100)', credit: 'Fuente: INEGI', url: 'https://www.inegi.org.mx' };
const KW = /varilla|alambr[oó]n|l[aá]mina|placa|perfil|viga|tubo|tuber[ií]a|chatarra|mineral de hierro|coque|acero|aluminio|cobre|zinc|cinc|n[ií]quel|plomo/i;

class InegiConfigError extends Error {}
class InegiError extends Error { constructor(status, detail) { super('INEGI request failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }

function token() { const t = process.env.INEGI_TOKEN; if (!t || !t.trim()) throw new InegiConfigError('INEGI_TOKEN is not set'); return t.trim(); }
function redactStr(s) { const t = process.env.INEGI_TOKEN && process.env.INEGI_TOKEN.trim(); return t ? String(s).split(t).join('[redacted]') : String(s); }

async function getJson(path, fetchImpl, ms) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms || 20000);
  try {
    const res = await fetchImpl(BASE + path.replace('{TOKEN}', encodeURIComponent(token())) + '?type=json', { signal: ctl.signal, headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw new InegiError(res.status, redactStr(text.slice(0, 200)));
    try { return JSON.parse(text); } catch (e) { throw new InegiError('invalid-json', redactStr(text.slice(0, 200))); }
  } catch (e) { if (e.name === 'AbortError') throw new InegiError('timeout'); throw e; }
  finally { clearTimeout(timer); }
}

function createInegi(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  // 진단: (1) 토큰 확인(공식 예시 지표 1002000001, BISE) (2) BIE 지표 목록에서 철강 관련 이름
  async function probe() {
    token();
    const out = { checkedAt: new Date().toISOString() };
    try {
      const t = await getJson('/INDICATOR/1002000001/es/00/true/BISE/2.0/{TOKEN}', fetchImpl);
      out.tokenOk = Boolean(t && t.Series && t.Series.length);
    } catch (e) { out.tokenOk = false; out.tokenError = String(e.status || e.message) + ' ' + (e.detail || ''); }
    try {
      const cat = await getJson('/CL_INDICATOR/null/es/BIE/2.0/{TOKEN}', fetchImpl, 45000);
      const list = (cat && (cat.CODE || cat.Code || cat.code)) || (Array.isArray(cat) ? cat : []);
      out.catalogSize = list.length;
      out.matches = list.filter(c => KW.test(String(c.Description || c.description || ''))).slice(0, 150).map(c => (c.value || c.Value || c.id) + ' ' + (c.Description || c.description));
      if (!list.length) out.catalogSample = JSON.stringify(cat).slice(0, 500);
    } catch (e) { out.catalogError = String(e.status || e.message) + ' ' + (e.detail || ''); }
    return JSON.parse(redactStr(JSON.stringify(out)));
  }
  return { probe };
}

module.exports = { createInegi, InegiConfigError, InegiError, SOURCE };
