'use strict';
// 중국 국가통계국 「流通领域重要生产资料市场价格变动情况」(열흘마다 발표) 자동 수집.
// API가 없어 공개 발표 페이지를 읽는다. 하루 몇 번만, 결과는 캐시한다. 출처 표시 조건으로 인용.
// 키가 필요 없다.

const LIST_URLS = (process.env.NBS_LIST_URLS || 'https://www.stats.gov.cn/sj/zxfb/,https://www.stats.gov.cn/sj/zxfb/index_1.html,https://www.stats.gov.cn/sj/zxfb/index_2.html').split(',');
const TITLE_KEY = '流通领域重要生产资料市场价格变动情况';
const SOURCE = { name: '中国国家统计局 「流通领域重要生产资料市场价格变动情况」', url: 'https://www.stats.gov.cn' };
const UA = 'Mozilla/5.0 (compatible; FelixDataBot/1.0; steel price research)';
// 앱 항목 ↔ 발표 표의 품목 이름(앞부분 일치)
const PRODUCTS = [
  { id: 'cn1', name: '螺纹钢' }, { id: 'cn2', name: '线材' }, { id: 'cn3', name: '普通中板' }, { id: 'cn4', name: '热轧普通板卷' },
  { id: 'cn5', name: '无缝钢管' }, { id: 'cn6', name: '角钢' }, { id: 'cn7', name: '焦煤' }, { id: 'cn8', name: '焦炭' },
  { id: 'cu', name: '电解铜' }, { id: 'al', name: '铝锭' }, { id: 'pb', name: '铅锭' }, { id: 'zn', name: '锌锭' }
];
const TTL_MS = 6 * 60 * 60 * 1000;

class NbsError extends Error { constructor(status, detail) { super('NBS request failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
}
function text(html) { return decodeEntities(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); }
function num(s) { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; }

async function getHtml(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw new NbsError(res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  let html = buf.toString('utf8');
  const cs = (res.headers && res.headers.get && res.headers.get('content-type') || '') + ' ' + (html.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (/gb2312|gbk|gb18030/i.test(cs)) { try { html = new TextDecoder('gb18030').decode(buf); } catch (e) { /* utf8 유지 */ } }
  return html;
}

// 목록 페이지에서 해당 발표 링크들(최신순)
function findLinks(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = text(m[2]) || (m[0].match(/title=["']([^"']+)["']/i) || [])[1] || '';
    if (!t.includes(TITLE_KEY)) continue;
    try { out.push({ title: t, url: new URL(m[1], baseUrl).toString() }); } catch (e) { /* skip */ }
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.url) && seen.add(x.url));
}

// 발표 본문 → 기간과 품목 행
function parseRelease(html) {
  const title = text((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const head = (title.match(/(\d{4})年(\d{1,2})月(上旬|中旬|下旬)/) || text(html).match(/(\d{4})年(\d{1,2})月(上旬|中旬|下旬)/));
  const period = head ? { year: Number(head[1]), month: Number(head[2]), part: head[3], label: head[0] } : null;
  const rows = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => text(c[1]));
    if (cells.length >= 5) rows.push(cells);
  }
  const items = {};
  PRODUCTS.forEach(p => {
    const r = rows.find(c => c[0].replace(/\s/g, '').startsWith(p.name));
    if (!r) return;
    // 열: 품목(규격) | 단위 | 본기 가격 | 전기 대비 변동(위안) | 변동률(%)
    const n = r.length;
    const price = num(r[n - 3]), chg = num(r[n - 2]), pct = num(r[n - 1]);
    if (price == null) return;
    items[p.id] = { name: r[0], unit: r[n - 4] || '', price, change: chg, changePct: pct, prev: chg != null ? Math.round((price - chg) * 10) / 10 : null };
  });
  return { title, period, items, rowCount: rows.length };
}

function createNbs(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const log = (opts && opts.log) || ((m) => console.log(m));
  let cache = null;

  async function locate() {
    const tried = [];
    for (const u of LIST_URLS) {
      try {
        const links = findLinks(await getHtml(u, fetchImpl), u);
        tried.push({ list: u, found: links.length });
        if (links.length) return { links, tried };
      } catch (e) { tried.push({ list: u, error: String(e.status || (e.cause && e.cause.code) || e.message) }); }
    }
    return { links: [], tried };
  }

  async function latest() {
    if (cache && cache.exp > Date.now()) return cache.value;
    const loc = await locate();
    if (!loc.links.length) throw new NbsError('no-release', '발표 목록에서 해당 자료를 찾지 못했습니다.');
    const r = parseRelease(await getHtml(loc.links[0].url, fetchImpl));
    const ok = Object.keys(r.items).length;
    if (!ok) throw new NbsError('parse', '발표 표를 읽지 못했습니다.');
    log('nbs period=' + (r.period && r.period.label) + ' items=' + ok);
    const value = { status: 'ok', source: SOURCE, url: loc.links[0].url, period: r.period, items: r.items, fetchedAt: new Date().toISOString() };
    cache = { value, exp: Date.now() + TTL_MS };
    return value;
  }

  async function probe() {
    const loc = await locate();
    let parsed = null;
    if (loc.links[0]) { try { parsed = parseRelease(await getHtml(loc.links[0].url, fetchImpl)); } catch (e) { parsed = { error: String(e.status || e.message) }; } }
    return { tried: loc.tried, links: loc.links.slice(0, 5), parsed, checkedAt: new Date().toISOString() };
  }

  return { latest, probe };
}

module.exports = { createNbs, parseRelease, findLinks, NbsError, PRODUCTS };
