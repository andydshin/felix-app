'use strict';
// 세계 철강 이슈 수집. 기사 본문은 가져오지 않는다(저작권). 제목·매체·날짜·링크만 모아 AI 초안의 재료로 쓴다.
//  - GDELT DOC 2.0 API: 전 세계 뉴스 제목 검색(무료·키 없음). 요청은 5초에 1번 이하로 보낸다.
//  - Google 뉴스 RSS 검색: GDELT가 막히거나(서버 IP 차단·429) 비었을 때를 대비한 두 번째 경로. 제목·매체·날짜·링크만 쓴다(이용 조건 법률 검토 대상).
//  - 미국 Federal Register API: 상무부 국제무역청(ITA)의 철강 반덤핑·상계관세·232조 공고(미국 정부 저작물, 퍼블릭 도메인).

const GDELT = process.env.GDELT_BASE || 'https://api.gdeltproject.org/api/v2/doc/doc';
const FEDREG = process.env.FEDREG_BASE || 'https://www.federalregister.gov/api/v1/documents.json';
const GNEWS = process.env.GNEWS_BASE || 'https://news.google.com/rss/search';
const GN_QUERIES = [
  { id: 'trade', q: 'steel (tariff OR "anti-dumping" OR safeguard OR quota OR CBAM OR "Section 232")', hl: 'en-US', gl: 'US', ceid: 'US:en' },
  { id: 'market', q: '("steel prices" OR "iron ore" OR "coking coal" OR "crude steel" OR "steel demand")', hl: 'en-US', gl: 'US', ceid: 'US:en' },
  { id: 'mills', q: '("Nippon Steel" OR JFE OR POSCO OR "Hyundai Steel" OR Baosteel OR Nucor OR ArcelorMittal) (price OR prices OR hike OR increase)', hl: 'en-US', gl: 'US', ceid: 'US:en' },
  { id: 'korea', q: '철강 (가격 OR 관세 OR 열연 OR 철근 OR 후판 OR 반덤핑)', hl: 'ko', gl: 'KR', ceid: 'KR:ko' },
  { id: 'japan', q: '鉄鋼 (価格 OR 値上げ OR 関税)', hl: 'ja', gl: 'JP', ceid: 'JP:ja' }
];
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

// RSS(XML) 아주 작은 파서: item의 title·link·pubDate·source만
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
const unent = t => String(t || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => (ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : m))).trim();
function parseRss(xml) {
  return String(xml || '').split(/<item[\s>]/).slice(1).map(chunk => {
    const tag = n => { const m = chunk.match(new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>')); return m ? unent(m[1]) : ''; };
    const srcUrl = (chunk.match(/<source[^>]*url="([^"]+)"/) || [])[1] || '';
    const source = tag('source');
    let title = tag('title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    const d = new Date(tag('pubDate'));
    return { title, url: safeUrl(tag('link')), source: source || srcUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, ''), date: isNaN(d) ? null : d.toISOString().slice(0, 10) };
  }).filter(x => x.title && x.url);
}
async function getText(url, fetchImpl) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl && setTimeout(() => ctl.abort(), 12000);
  let res, text;
  try { res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' }, signal: ctl ? ctl.signal : undefined }); text = await res.text(); }
  catch (e) { throw Object.assign(new Error('network'), { status: e.name === 'AbortError' ? 'timeout' : 'network' }); }
  finally { if (t) clearTimeout(t); }
  if (!res.ok) throw Object.assign(new Error('http ' + res.status), { status: res.status });
  return text;
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

  // Google 뉴스 RSS. 질의마다 따로(병렬), 최근 days일, 질의당 25건
  async function gnews(days, queries) {
    const qs = queries || GN_QUERIES, errors = [];
    const res = await Promise.all(qs.map(async q => {
      const url = GNEWS + '?' + new URLSearchParams({ q: q.q + ' when:' + (days || 7) + 'd', hl: q.hl, gl: q.gl, ceid: q.ceid }).toString();
      try { return parseRss(await getText(url, fetchImpl)).slice(0, 25).map(a => Object.assign(a, { lang: q.hl.slice(0, 2), topic: q.id, kind: 'news', via: 'gnews' })); }
      catch (e) { errors.push({ query: q.id, status: String(e.status || e.message) }); return []; }
    }));
    return { items: dedupe([].concat.apply([], res)), errors };
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
    const [g, f, gn] = await Promise.allSettled([gdelt(days), fedreg(14), gnews(days)]);
    const gi = g.status === 'fulfilled' ? g.value.items : [], ni = gn.status === 'fulfilled' ? gn.value.items : [];
    const news = dedupe(gi.concat(ni)).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const official = f.status === 'fulfilled' ? f.value.items : [];
    // AI에 넘길 번호(n1, n2 …, o1 …)
    news.forEach((a, i) => { a.id = 'n' + (i + 1); });
    official.forEach((a, i) => { a.id = 'o' + (i + 1); });
    return { news: news.slice(0, 120), official, errors: { gdelt: g.status === 'fulfilled' ? g.value.errors : [{ status: String(g.reason && g.reason.message) }], gnews: gn.status === 'fulfilled' ? gn.value.errors : [{ status: String(gn.reason && gn.reason.message) }], counts: { gdelt: gi.length, gnews: ni.length }, fedreg: f.status === 'fulfilled' ? null : String(f.reason && (f.reason.status || f.reason.message)) }, collectedAt: new Date().toISOString() };
  }

  // 주제 검색(HS 검색 화면의 '관련 뉴스'): 질의 여러 개를 5초 간격으로, 제목·링크만
  async function topic(queries, days) {
    const out = [], errors = [];
    for (let i = 0; i < queries.length; i++) {
      if (i) await wait(5500);
      const url = GDELT + '?' + new URLSearchParams({ query: queries[i], mode: 'artlist', format: 'json', maxrecords: '40', timespan: (days || 90) + 'd', sort: 'hybridrel' }).toString();
      try {
        const j = await getJson(url, fetchImpl);
        (j.articles || []).forEach(a => { const u = safeUrl(a.url); if (u && a.title) out.push({ title: String(a.title).trim(), url: u, source: a.domain || '', date: gdeltDate(a.seendate), lang: a.language || '' }); });
      } catch (e) { errors.push({ query: i, status: String(e.status || e.message) }); }
    }
    // GDELT가 거의 비면 Google 뉴스로 같은 질의를 다시(언어 표시 sourcelang:xx → hl/gl)
    if (out.length < 3) {
      const LG = { english: ['en-US', 'US', 'US:en', 'English'], spanish: ['es-419', 'MX', 'MX:es-419', 'Spanish'], korean: ['ko', 'KR', 'KR:ko', 'Korean'] };
      const qs = queries.map((q, i) => { const m = String(q).match(/sourcelang:(\w+)/), l = LG[(m && m[1]) || 'english'] || LG.english; return { id: 'q' + i, q: String(q).replace(/\s*sourcelang:\w+/g, '').trim(), hl: l[0], gl: l[1], ceid: l[2], lang: l[3] }; });
      const g2 = await gnews(days || 90, qs);
      g2.items.forEach(a => { const q = qs.find(x => x.id === a.topic); out.push(Object.assign({}, a, { lang: q ? q.lang : a.lang })); });
      g2.errors.forEach(e => errors.push(Object.assign({ via: 'gnews' }, e)));
    }
    return { items: dedupe(out).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 12), errors };
  }

  return { collect, gdelt, gnews, fedreg, topic };
}

module.exports = { createNews, dedupe, safeUrl, parseRss, QUERIES, GN_QUERIES };
