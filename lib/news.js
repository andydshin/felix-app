'use strict';
// 세계 철강 이슈 수집. 기사 본문은 가져오지 않는다(저작권). 제목·매체·날짜·링크만 모아 AI 초안의 재료로 쓴다.
//  - GDELT DOC 2.0 API: 전 세계 뉴스 제목 검색(무료·키 없음). 요청은 5초에 1번 이하로 보낸다.
//  - 미국 Federal Register API: 상무부 국제무역청(ITA)의 철강 반덤핑·상계관세·232조 공고(미국 정부 저작물, 퍼블릭 도메인).

const GDELT = process.env.GDELT_BASE || 'https://api.gdeltproject.org/api/v2/doc/doc';
const FEDREG = process.env.FEDREG_BASE || 'https://www.federalregister.gov/api/v1/documents.json';
const UA = 'Mozilla/5.0 (compatible; FelixDataBot/1.0; steel price research)';
const QUERIES = [
  { id: 'trade', q: 'steel (tariff OR tariffs OR "anti-dumping" OR antidumping OR safeguard OR quota OR CBAM OR "Section 232") sourcelang:english' },
  { id: 'market', q: '("steel prices" OR "steel output" OR "steel production" OR "crude steel" OR "iron ore" OR "coking coal" OR "steel demand") sourcelang:english' },
  { id: 'korea', q: '(철강 OR 열연 OR 철근 OR 후판) sourcelang:korean' }
];

const safeUrl = u => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);
function gdeltDate(s) { const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})/); return m ? m[1] + '-' + m[2] + '-' + m[3] : null; }
function norm(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9가-힣 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

// 비슷한 제목 묶기(단어 겹침 60% 이상이면 같은 이슈로 보고 하나만 남긴다)
function dedupe(list) {
  const out = [];
  list.forEach(a => {
    const w = new Set(norm(a.title).split(' ').filter(x => x.length > 2));
    const dup = out.find(b => { const v = b._w; let c = 0; w.forEach(x => { if (v.has(x)) c++; }); return w.size && c / Math.min(w.size, v.size || 1) >= 0.6; });
    if (dup) { dup.also = (dup.also || 0) + 1; return; }
    out.push(Object.assign({ _w: w }, a));
  });
  return out.map(a => { const o = Object.assign({}, a); delete o._w; return o; });
}

async function getJson(url, fetchImpl) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl && setTimeout(() => ctl.abort(), 15000);
  let res, text;
  try { res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined }); text = await res.text(); }
  catch (e) { throw Object.assign(new Error('network'), { status: e.name === 'AbortError' ? 'timeout' : 'network', detail: String(e.cause && e.cause.code || e.message) }); }
  finally { if (t) clearTimeout(t); }
  if (!res.ok) throw Object.assign(new Error('http ' + res.status), { status: res.status, detail: text.slice(0, 200) });
  try { return JSON.parse(text); } catch (e) { throw Object.assign(new Error('invalid-json'), { status: 'invalid-json', detail: text.slice(0, 200) }); }
}

function createNews(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const wait = (opts && opts.wait) || (ms => new Promise(r => setTimeout(r, ms)));
  const now = (opts && opts.now) || (() => new Date());

  async function gdelt(days) {
    const out = [], errors = [];
    for (let i = 0; i < QUERIES.length; i++) {
      if (i) await wait(5500); // GDELT 이용 규칙: 5초에 1번
      const q = QUERIES[i];
      const url = GDELT + '?' + new URLSearchParams({ query: q.q, mode: 'artlist', format: 'json', maxrecords: '60', timespan: (days || 7) + 'd', sort: 'hybridrel' }).toString();
      try {
        const j = await getJson(url, fetchImpl);
        (j.articles || []).forEach(a => { const u = safeUrl(a.url); if (u && a.title) out.push({ title: String(a.title).trim(), url: u, source: a.domain || '', date: gdeltDate(a.seendate), lang: a.language || '', country: a.sourcecountry || '', topic: q.id, kind: 'news' }); });
      } catch (e) { errors.push({ query: q.id, status: String(e.status || e.message), detail: e.detail }); }
    }
    return { items: dedupe(out), errors };
  }

  async function fedreg(days) {
    const since = new Date(now().getTime() - (days || 14) * 86400000).toISOString().slice(0, 10);
    const p = new URLSearchParams({ 'conditions[term]': 'steel', 'conditions[agencies][]': 'international-trade-administration', 'conditions[publication_date][gte]': since, order: 'newest', per_page: '50' });
    ['title', 'html_url', 'publication_date', 'type', 'abstract'].forEach(f => p.append('fields[]', f));
    const j = await getJson(FEDREG + '?' + p.toString(), fetchImpl);
    // 정기 행정 재심(administrative review) 같은 일상 공고는 뒤로, 개시·판정·232조는 앞으로
    const score = t => (/section 232|inclusion|initiation|preliminary determination|final determination|antidumping duty order|countervailing duty order|circumvention/i.test(t) ? 2 : 0) - (/administrative review|extension of time|rescission|sunset/i.test(t) ? 1 : 0);
    const items = (j.results || []).map(r => ({ title: String(r.title || '').trim(), url: safeUrl(r.html_url), source: 'federalregister.gov', date: r.publication_date, abstract: String(r.abstract || '').slice(0, 300), kind: 'official', topic: 'us-trade' }))
      .filter(r => r.url && r.title).sort((a, b) => score(b.title) - score(a.title)).slice(0, 25);
    return { items, count: j.count || 0 };
  }

  async function collect(days) {
    const [g, f] = await Promise.allSettled([gdelt(days), fedreg(14)]);
    const news = g.status === 'fulfilled' ? g.value.items : [];
    const official = f.status === 'fulfilled' ? f.value.items : [];
    // AI에 넘길 번호(n1, n2 …, o1 …)
    news.forEach((a, i) => { a.id = 'n' + (i + 1); });
    official.forEach((a, i) => { a.id = 'o' + (i + 1); });
    return { news: news.slice(0, 120), official, errors: { gdelt: g.status === 'fulfilled' ? g.value.errors : [{ status: String(g.reason && g.reason.message) }], fedreg: f.status === 'fulfilled' ? null : String(f.reason && (f.reason.status || f.reason.message)) }, collectedAt: new Date().toISOString() };
  }

  return { collect, gdelt, fedreg };
}

module.exports = { createNews, dedupe, safeUrl, QUERIES };
