'use strict';
// 일본 e-Stat API (재무성 普通貿易統計). 앱 ID는 서버 환경변수 ESTAT_APP_ID에서만 읽는다.
// 앱 ID가 들어간 URL은 로그·응답·오류 메시지에 넣지 않는다. 응답 직전에 한 번 더 지운다(redact).

const BASE = process.env.ESTAT_API_BASE || 'https://api.e-stat.go.jp/rest/3.0/app/json';
const TRADE_STATS_CODE = '00350300'; // 普通貿易統計
const CREDIT = 'このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。';
// 표 구조 확인용 샘플 품목: 열연 코일(7208.27), 철광석(2601), 알루미늄 괴(7601)
const PROBE_CODES = ['720827', '7208', '2601', '7601'];

class EstatConfigError extends Error {}
class EstatUpstreamError extends Error {
  constructor(status, detail) { super('e-Stat request failed (' + status + ')'); this.status = status; this.detail = detail || ''; }
}

function appId() {
  const k = process.env.ESTAT_APP_ID;
  if (!k || !k.trim()) throw new EstatConfigError('ESTAT_APP_ID is not set on the server');
  return k.trim();
}

// e-Stat JSON은 원소가 하나면 배열이 아니라 객체로 온다.
function arr(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
function txt(v) { return v == null ? '' : typeof v === 'object' ? String(v.$ != null ? v.$ : '') : String(v); }

function redactStr(s) {
  const k = process.env.ESTAT_APP_ID && process.env.ESTAT_APP_ID.trim();
  return k ? String(s).split(k).join('[redacted]') : String(s);
}
function redact(value) { return JSON.parse(redactStr(JSON.stringify(value))); }

async function call(method, params, fetchImpl) {
  const qs = new URLSearchParams(Object.assign({ appId: appId(), lang: 'J' }, params));
  const res = await fetchImpl(BASE + '/' + method + '?' + qs.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new EstatUpstreamError(res.status);
  let body;
  try { body = JSON.parse(await res.text()); } catch (e) { throw new EstatUpstreamError('invalid-json'); }
  const root = body[Object.keys(body)[0]] || {};
  const result = root.RESULT || {};
  const status = Number(result.STATUS);
  // 0 정상, 1 해당 데이터 없음, 2 일부 경고. 100 이상은 오류(잘못된 앱 ID 포함).
  if (status >= 100) throw new EstatUpstreamError('api-' + status, redactStr(txt(result.ERROR_MSG)));
  return { status, root };
}

function summarizeTable(t) {
  const spec = t.TITLE_SPEC || {};
  return {
    id: t['@id'],
    title: txt(t.TITLE),
    tableName: txt(spec.TABLE_NAME),
    statName: txt(t.STATISTICS_NAME),
    cycle: txt(t.CYCLE),
    surveyDate: txt(t.SURVEY_DATE),
    openDate: txt(t.OPEN_DATE),
    updated: txt(t.UPDATED_DATE),
    records: Number(txt(t.OVERALL_TOTAL_NUMBER)) || null
  };
}

function summarizeMeta(classObjs) {
  return classObjs.map(o => {
    const classes = arr(o.CLASS);
    const pick = c => ({ code: c['@code'], name: c['@name'], unit: c['@unit'] || undefined, level: c['@level'] || undefined });
    const out = { id: o['@id'], name: o['@name'], count: classes.length, first: classes.slice(0, 6).map(pick) };
    if (classes.length > 12) out.last = classes.slice(-4).map(pick);
    const hits = classes.filter(c => PROBE_CODES.some(p => String(c['@code']).startsWith(p))).slice(0, 8).map(pick);
    if (hits.length) out.sampleSteel = hits;
    return out;
  });
}

function paramFor(dimId) { return 'cd' + dimId.charAt(0).toUpperCase() + dimId.slice(1); }

function createEstat(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const log = (opts && opts.log) || ((m) => console.log(m));

  // 진단: 무역통계 품목·국가별 표 목록과, 최신 수출·수입 표의 구조(차원·코드 예시·샘플 값)를 보여준다.
  async function probe() {
    appId();
    const list = await call('getStatsList', { statsCode: TRADE_STATS_CODE, searchWord: '品別国別表', limit: '200' }, fetchImpl);
    const tables = arr(list.root.DATALIST_INF && list.root.DATALIST_INF.TABLE_INF).map(summarizeTable);
    tables.sort((a, b) => String(b.surveyDate).localeCompare(String(a.surveyDate)) || String(b.updated).localeCompare(String(a.updated)));
    const label = t => t.title + ' ' + t.tableName;
    const latest = {
      export: tables.find(t => /輸出/.test(label(t))) || null,
      import: tables.find(t => /輸入/.test(label(t))) || null
    };
    const detail = {};
    for (const flow of ['export', 'import']) {
      const t = latest[flow];
      if (!t) continue;
      const meta = await call('getMetaInfo', { statsDataId: t.id }, fetchImpl);
      const objs = arr(meta.root.METADATA_INF && meta.root.METADATA_INF.CLASS_INF && meta.root.METADATA_INF.CLASS_INF.CLASS_OBJ);
      const dims = summarizeMeta(objs);
      const d = { table: t, dimensions: dims };
      // 열연 코일(또는 첫 철강 코드)로 실제 값 몇 줄을 받아 단위·구조를 확인한다.
      const steelDim = dims.find(x => x.sampleSteel && x.sampleSteel.length);
      if (steelDim) {
        const code = steelDim.sampleSteel[0].code;
        const params = { statsDataId: t.id, metaGetFlg: 'N', limit: '40' };
        params[paramFor(steelDim.id)] = code;
        try {
          const data = await call('getStatsData', params, fetchImpl);
          const sd = data.root.STATISTICAL_DATA || {};
          d.sample = {
            filter: { dimension: steelDim.id, code },
            total: Number(txt(sd.RESULT_INF && sd.RESULT_INF.TOTAL_NUMBER)) || 0,
            values: arr(sd.DATA_INF && sd.DATA_INF.VALUE).slice(0, 40),
            notes: arr(sd.DATA_INF && sd.DATA_INF.NOTE).map(n => ({ char: n['@char'], text: txt(n) }))
          };
        } catch (e) { d.sample = { error: e.message }; }
      }
      detail[flow] = d;
    }
    log('estat probe tables=' + tables.length + ' export=' + (latest.export && latest.export.id) + ' import=' + (latest.import && latest.import.id));
    return redact({ credit: CREDIT, tableCount: tables.length, tables: tables.slice(0, 30), latest: detail, checkedAt: new Date().toISOString() });
  }

  return { probe };
}

module.exports = { createEstat, EstatConfigError, EstatUpstreamError, CREDIT, TRADE_STATS_CODE, arr, txt, redact, redactStr, call, appId, summarizeTable };
