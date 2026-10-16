'use strict';
// 무역 규제 타임라인: 미국 관보(Federal Register)의 상무부 국제무역청(ITA) 철강 관련 반덤핑·상계관세·세이프가드·232조 공고.
// 미국 정부 저작물(퍼블릭 도메인). 제목에서 단계·품목·대상국을 뽑고, DATES 항목에서 앞으로의 기한을 찾는다.
//  GET /api/remedies → { status, updatedAt, items: [{ id, date, stage, stageKo, product, productKo, countries[], countriesKo[], korea, title, url, deadlines: [{date, text}] }], upcoming: [...] }
const FEDREG = process.env.FEDREG_BASE || 'https://www.federalregister.gov/api/v1/documents.json';
const TTL_MS = 6 * 3600 * 1000;
const UA = 'Mozilla/5.0 (compatible; FelixDataBot/1.0; steel trade research)';

const STAGES = [
  [/section 232|inclusion request|derivative/i, 's232', '232조'],
  [/initiation of antidumping and countervailing duty administrative reviews|opportunity to request administrative review/i, 'admin', '연례 재심 공지'],
  [/initiation of (less-than-fair-value|countervailing duty) investigation|petitions?.*initiation|initiation of antidumping/i, 'init', '조사 개시'],
  [/preliminary (affirmative|negative)? ?determination|preliminary results/i, 'prelim', '예비 판정'],
  [/final (affirmative|negative)? ?determination|final results/i, 'final', '최종 판정'],
  [/antidumping duty order|countervailing duty order|amended .*order/i, 'order', '관세 부과 명령'],
  [/sunset review|continuation of antidumping|revocation/i, 'sunset', '일몰 재심'],
  [/circumvention|scope ruling|covered merchandise/i, 'scope', '우회·범위 판정'],
  [/court decision|remand/i, 'court', '법원 판결 반영'],
  [/extension|postponement|correction/i, 'notice', '일정·정정 공고']
];
const COUNTRY = {
  'Republic of Korea': '한국', 'Korea': '한국', "People's Republic of China": '중국', 'China': '중국', 'Japan': '일본', 'Taiwan': '대만', 'India': '인도',
  'Vietnam': '베트남', 'Socialist Republic of Vietnam': '베트남', 'Mexico': '멕시코', 'Canada': '캐나다', 'Brazil': '브라질', 'Turkey': '튀르키예', 'Republic of Türkiye': '튀르키예',
  'Russian Federation': '러시아', 'Russia': '러시아', 'Germany': '독일', 'Italy': '이탈리아', 'Indonesia': '인도네시아', 'Malaysia': '말레이시아', 'Thailand': '태국',
  'United Arab Emirates': 'UAE', 'Sultanate of Oman': '오만', 'Oman': '오만', 'Netherlands': '네덜란드', 'United Kingdom': '영국', 'Australia': '호주', 'South Africa': '남아공',
  'Saudi Arabia': '사우디', 'Egypt': '이집트', 'Ukraine': '우크라이나', 'Argentina': '아르헨티나', 'Spain': '스페인', 'France': '프랑스', 'Austria': '오스트리아', 'Sweden': '스웨덴', 'Belgium': '벨기에'
};
const PRODUCT = [
  [/hot-rolled|hot rolled/i, '열연'], [/cold-rolled|cold rolled/i, '냉연'], [/corrosion[- ]resistant|galvaniz/i, '도금강판'], [/tin mill|tinplate/i, '석도강판'],
  [/cut-to-length.*plate|steel plate|carbon.*plate/i, '후판'], [/rebar|reinforcing bar/i, '철근'], [/wire rod/i, '선재'], [/stainless.*(sheet|strip|coil)/i, '스테인리스 판재'],
  [/stainless/i, '스테인리스'], [/oil country tubular|octg/i, '유정용 강관'], [/line pipe/i, '송유관'], [/pipe|tube|tubular/i, '강관'], [/nails?\b/i, '못'], [/wire\b|strand/i, '와이어'],
  [/fittings?|flanges?/i, '관이음쇠'], [/forg/i, '단조품'], [/shelving|racks|sinks?|grills?|drums?|containers?|truck bed/i, '철강 가공품'], [/electrodes?/i, '흑연 전극'],
  [/structural|beam|section/i, '형강'], [/silicon|electrical steel|grain-oriented/i, '전기강판'], [/steel/i, '철강재']
];

function stageOf(t) { for (const [re, id, ko] of STAGES) if (re.test(t)) return { stage: id, stageKo: ko }; return { stage: 'other', stageKo: '공고' }; }
function countriesOf(t) {
  const head = String(t).split(':')[0], m = head.match(/\bFrom (?:the )?(.+)$/i);
  if (!m) return [];
  return m[1].split(/,\s*(?:and\s+)?|\s+and\s+/).map(x => x.replace(/^the\s+/i, '').trim()).filter(Boolean);
}
function productOf(t) { const head = String(t).split(':')[0]; const m = head.match(/^(.*?)\s+From\s/i); return (m ? m[1] : head).replace(/^Certain\s+/i, '').trim(); }
function productKo(p) { for (const [re, ko] of PRODUCT) if (re.test(p)) return ko; return '기타'; }
const MON = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
// DATES 문단에서 날짜 + 앞 문맥
function deadlinesOf(text, today) {
  const out = [], re = /([^.;]{0,120}?)\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/g;
  let m; const s = String(text || '');
  while ((m = re.exec(s))) {
    const d = m[4] + '-' + String(MON[m[2].toLowerCase()]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
    if (d > today) {
      const ctx = m[1].toLowerCase();
      const what = /comment|argument|brief/.test(ctx) ? '의견 제출 마감' : /hearing/.test(ctx) ? '공청회' : /final/.test(ctx) ? '최종 판정 예정' : /preliminary/.test(ctx) ? '예비 판정 예정' : /effective|applicable/.test(ctx) ? '발효' : '기한';
      out.push({ date: d, what });
    }
  }
  return out.slice(0, 3);
}

function shape(r, today) {
  const t = String(r.title || '').trim(), st = stageOf(t), cs = countriesOf(t), prod = productOf(t);
  const ko = cs.map(c => COUNTRY[c] || c);
  const dl = deadlinesOf([r.dates, r.abstract].filter(Boolean).join(' '), today);
  if (r.comments_close_on && r.comments_close_on > today && !dl.some(x => x.date === r.comments_close_on)) dl.unshift({ date: r.comments_close_on, what: '의견 제출 마감' });
  return { id: r.document_number || r.html_url, date: r.publication_date, title: t, url: /^https?:\/\//.test(r.html_url || '') ? r.html_url : null,
    stage: st.stage, stageKo: st.stageKo, product: prod, productKo: productKo(prod), countries: cs, countriesKo: [...new Set(ko)], korea: ko.includes('한국'), deadlines: dl };
}

function createRemedies(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch, kv = opts && opts.kv, now = (opts && opts.now) || (() => new Date());
  let mem = null;
  async function load(days) {
    const since = new Date(now().getTime() - (days || 120) * 86400000).toISOString().slice(0, 10);
    const p = new URLSearchParams({ 'conditions[term]': 'steel', 'conditions[agencies][]': 'international-trade-administration', 'conditions[publication_date][gte]': since, order: 'newest', per_page: '200' });
    ['title', 'html_url', 'publication_date', 'abstract', 'dates', 'comments_close_on', 'document_number'].forEach(f => p.append('fields[]', f));
    const res = await fetchImpl(FEDREG + '?' + p.toString(), { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error('fedreg ' + res.status), { status: res.status });
    const j = JSON.parse(await res.text());
    const today = now().toISOString().slice(0, 10);
    const items = (j.results || []).map(r => shape(r, today)).filter(x => x.url && x.title && x.stage !== 'admin');
    const upcoming = [];
    items.forEach(x => x.deadlines.forEach(d => upcoming.push({ date: d.date, what: d.what, productKo: x.productKo, countriesKo: x.countriesKo, korea: x.korea, stageKo: x.stageKo, url: x.url, id: x.id })));
    upcoming.sort((a, b) => a.date.localeCompare(b.date));
    return { status: 'ok', updatedAt: now().toISOString(), source: 'Federal Register (U.S. Department of Commerce, ITA)', count: items.length, items, upcoming: upcoming.slice(0, 30) };
  }
  return {
    async get() {
      if (mem && mem.exp > Date.now()) return mem.v;
      const k = 'remedies:v1';
      if (kv) { const c = await kv.get(k).catch(() => null); if (c && c.savedAt && Date.now() - c.savedAt < TTL_MS) { mem = { v: c.v, exp: Date.now() + 600000 }; return c.v; } }
      try {
        const v = await load(120);
        mem = { v, exp: Date.now() + 600000 };
        if (kv) await kv.set(k, { savedAt: Date.now(), v }).catch(() => {});
        return v;
      } catch (e) {
        if (kv) { const c = await kv.get(k).catch(() => null); if (c && c.v) return Object.assign({}, c.v, { stale: true }); }
        throw e;
      }
    },
    shape, stageOf, countriesOf, productOf, deadlinesOf
  };
}

module.exports = { createRemedies, shape, stageOf, countriesOf, productOf, productKo, deadlinesOf };
