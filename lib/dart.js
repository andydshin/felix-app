'use strict';
// 금융감독원 전자공시(OpenDART): 국내 철강사의 공급 관련 공시(생산 중단, 재해, 시설 투자, 대형 공급계약 등).
//  키는 서버 환경변수 DART_API_KEY에서만 읽는다(무료 발급). 없으면 조용히 건너뛴다.
//  회사 고유번호는 corpCode.xml(zip)에서 찾아 KV에 30일 보관한다.
const { unzip } = require('./xlsx-lite');
const BASE = process.env.DART_BASE || 'https://opendart.fss.or.kr/api';
const TARGETS = ['포스코홀딩스', '현대제철', '동국제강', '동국씨엠', 'KG스틸', '세아베스틸지주', '세아제강', '세아제강지주', '대한제강', '한국철강', '고려제강', '포스코스틸리온', '휴스틸', '하이스틸', '부국철강'];
const PICK = /생산중단|영업정지|재해발생|신규시설투자|유형자산\s*(취득|양수|양도|처분)|단일판매\s*[ㆍ·]?\s*공급계약|영업양수|영업양도|회사합병|회사분할|조업/;
const key = () => String(process.env.DART_API_KEY || '').trim();
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

function parseCorpXml(xml, wanted) {
  const out = {}, want = new Set(wanted);
  const re = /<list>([\s\S]*?)<\/list>/g; let m;
  while ((m = re.exec(xml))) {
    const b = m[1], name = ((b.match(/<corp_name>([^<]*)<\/corp_name>/) || [])[1] || '').trim(), code = (b.match(/<corp_code>(\d+)<\/corp_code>/) || [])[1], stock = ((b.match(/<stock_code>([^<]*)<\/stock_code>/) || [])[1] || '').trim();
    if (code && want.has(name) && (!out[name] || stock)) out[name] = code;   // 같은 이름이 여럿이면 상장사 우선
  }
  return out;
}

function createDart(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch, kv = opts && opts.kv, now = (opts && opts.now) || (() => new Date());
  async function corps() {
    const ck = 'dart:corp:v1';
    if (kv) { const c = await kv.get(ck).catch(() => null); if (c && c.savedAt && Date.now() - c.savedAt < 30 * 86400000 && c.map) return c.map; }
    const res = await fetchImpl(BASE + '/corpCode.xml?crtfc_key=' + encodeURIComponent(key()));
    if (!res.ok) throw Object.assign(new Error('dart corp ' + res.status), { status: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    const get = unzip(buf), xml = get('CORPCODE.xml');
    if (!xml) throw Object.assign(new Error('dart corp xml'), { status: 'bad_zip' });
    const map = parseCorpXml(xml, TARGETS);
    if (kv) await kv.set(ck, { savedAt: Date.now(), map }).catch(() => {});
    return map;
  }
  return {
    configured: () => !!key(),
    async recent(days) {
      if (!key()) return { items: [], status: 'not_configured' };
      const map = await corps(), end = now(), bgn = new Date(end.getTime() - (days || 14) * 86400000), items = [], errors = [];
      for (const name of Object.keys(map)) {
        const q = new URLSearchParams({ crtfc_key: key(), corp_code: map[name], bgn_de: ymd(bgn), end_de: ymd(end), page_count: '50' });
        try {
          const res = await fetchImpl(BASE + '/list.json?' + q.toString()); const j = await res.json();
          if (j.status && j.status !== '000' && j.status !== '013') { errors.push({ corp: name, status: j.status }); continue; }   // 013 = 조회 결과 없음
          (j.list || []).filter(r => PICK.test(r.report_nm || '')).forEach(r => items.push({
            title: name + ' · ' + String(r.report_nm).replace(/\s+/g, ' ').trim(), url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + r.rcept_no,
            source: 'DART 전자공시', date: String(r.rcept_dt || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), kind: 'official', topic: 'kr-disclosure'
          }));
        } catch (e) { errors.push({ corp: name, status: 'network' }); }
      }
      items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return { items: items.slice(0, 20), status: 'ok', corps: Object.keys(map).length, errors };
    }
  };
}

module.exports = { createDart, parseCorpXml, PICK, TARGETS };
