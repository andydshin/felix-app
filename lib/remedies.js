'use strict';
// 무역 규제 타임라인: 미국 관보(Federal Register)의 상무부 국제무역청(ITA) 철강 관련 반덤핑·상계관세·세이프가드·232조 공고.
// 미국 정부 저작물(퍼블릭 도메인). 제목에서 단계·품목·대상국을 뽑고, DATES 항목에서 앞으로의 기한을 찾는다.
//  GET /api/remedies → { status, updatedAt, items: [{ id, date, stage, stageKo, product, productKo, countries[], countriesKo[], korea, title, url, deadlines: [{date, text}] }], upcoming: [...] }
const FEDREG = process.env.FEDREG_BASE || 'https://www.federalregister.gov/api/v1/documents.json';
const TTL_MS = 6 * 3600 * 1000;
const UA = 'Mozilla/5.0 (compatible; FelixDataBot/1.0; steel trade research)';

// 순서가 곧 우선순위: 법원·재검토·우회·일몰을 먼저 거르고, 예비(preliminary)는 최종보다 먼저 본다.
const STAGES = [
  [/section 232|inclusion request|derivative/i, 's232', '232조'],
  [/initiation of antidumping and countervailing duty administrative reviews|opportunity to request administrative review|advance notification of sunset|initiation of five-year/i, 'admin', '정기 공지'],
  [/court decision|remand/i, 'court', '법원 판결 반영'],
  [/reopening|intent to reconsider/i, 'notice', '재검토 공고'],
  [/circumvention|scope ruling|covered merchandise|changed circumstances/i, 'scope', '우회·범위 판정'],
  [/sunset review|continuation of|revocation/i, 'sunset', '일몰 재심'],
  [/initiation of/i, 'init', '조사 개시'],
  [/duty orders?\s*$/i, 'order', '관세 부과 명령'],
  [/preliminary/i, 'prelim', '예비 판정'],
  [/\bfinal\b/i, 'final', '최종 판정'],
  [/rescission|recission|rescind/i, 'notice', '재심 철회'],
  [/extension|postponement|correction/i, 'notice', '일정·정정 공고']
];
// 철강 품목만: 제목의 품목(“From” 앞) 기준. 알루미늄·기계·화학 등은 뺀다.
const STEEL_RE = /steel|\biron\b|stainless|tubular|pipe|tube|rebar|reinforcing bar|wire rod|\bstrand\b|tin mill|flat[- ]rolled|flat products|plate in coils|cut-to-length|flanges|graphite electrode|wind towers|threaded rod|fluid end|grating|ferro|silicomanganese/i;
const NON_STEEL_RE = /alumin|information collection|hydraulic|tires|mattress|lawn mower/i;
function isSteel(prod, title) { return !!prod && STEEL_RE.test(prod) && !NON_STEEL_RE.test(prod + ' ' + title); }
const COUNTRY = {
  'Republic of Korea': '한국', 'Korea': '한국', "People's Republic of China": '중국', 'China': '중국', 'Japan': '일본', 'Taiwan': '대만', 'India': '인도',
  'Vietnam': '베트남', 'Socialist Republic of Vietnam': '베트남', 'Mexico': '멕시코', 'Canada': '캐나다', 'Brazil': '브라질', 'Turkey': '튀르키예', 'Republic of Türkiye': '튀르키예',
  'Russian Federation': '러시아', 'Russia': '러시아', 'Germany': '독일', 'Italy': '이탈리아', 'Indonesia': '인도네시아', 'Malaysia': '말레이시아', 'Thailand': '태국',
  'United Arab Emirates': 'UAE', 'Sultanate of Oman': '오만', 'Oman': '오만', 'Netherlands': '네덜란드', 'United Kingdom': '영국', 'Australia': '호주', 'South Africa': '남아공',
  'Saudi Arabia': '사우디', 'Egypt': '이집트', 'Ukraine': '우크라이나', 'Argentina': '아르헨티나', 'Spain': '스페인', 'France': '프랑스', 'Austria': '오스트리아', 'Sweden': '스웨덴', 'Belgium': '벨기에',
  'Poland': '폴란드', 'Bulgaria': '불가리아', 'Algeria': '알제리', 'Czech Republic': '체코', 'Czechia': '체코', 'Serbia': '세르비아', 'Cambodia': '캄보디아', 'Philippines': '필리핀',
  'Pakistan': '파키스탄', 'Sri Lanka': '스리랑카', 'Bangladesh': '방글라데시', 'Kazakhstan': '카자흐스탄', 'Belarus': '벨라루스', 'Moldova': '몰도바', 'Latvia': '라트비아', 'Lithuania': '리투아니아',
  'Estonia': '에스토니아', 'Romania': '루마니아', 'Hungary': '헝가리', 'Slovakia': '슬로바키아', 'Slovenia': '슬로베니아', 'Croatia': '크로아티아', 'Greece': '그리스', 'Portugal': '포르투갈',
  'Finland': '핀란드', 'Denmark': '덴마크', 'Norway': '노르웨이', 'Switzerland': '스위스', 'Ireland': '아일랜드', 'Luxembourg': '룩셈부르크', 'Israel': '이스라엘', 'Bahrain': '바레인',
  'Qatar': '카타르', 'Kuwait': '쿠웨이트', 'Morocco': '모로코', 'Tunisia': '튀니지', 'Singapore': '싱가포르', 'Hong Kong': '홍콩', 'Colombia': '콜롬비아', 'Chile': '칠레', 'Peru': '페루',
  'Ecuador': '에콰도르', 'Venezuela': '베네수엘라', 'Dominican Republic': '도미니카공화국', 'Trinidad and Tobago': '트리니다드토바고', 'New Zealand': '뉴질랜드', 'Laos': '라오스', 'Myanmar': '미얀마'
};
function countryKo(c) {
  if (COUNTRY[c]) return COUNTRY[c];
  const bare = c.replace(/^(?:the\s+)?(?:Federal Republic of|Socialist Republic of|People's Republic of|Republic of|Kingdom of|Sultanate of|State of)\s+/i, '').trim();
  return COUNTRY[bare] || bare;
}
const PRODUCT = [
  [/hot-rolled|hot rolled/i, '열연'], [/cold-rolled|cold rolled/i, '냉연'], [/corrosion[- ]resistant|galvaniz/i, '도금강판'], [/tin mill|tinplate/i, '석도강판'],
  [/stainless.*(sheet|strip|coil|plate)/i, '스테인리스 판재'], [/cut-to-length.*plate|steel plate|carbon.*plate/i, '후판'], [/rebar|reinforcing bar/i, '철근'], [/wire rod/i, '선재'],
  [/fittings?|flanges?/i, '관이음쇠'], [/stainless.*(pipe|tube)/i, '스테인리스 강관'], [/sinks?|shelving|racks|grills?|drums?|containers?|truck bed|hangers/i, '철강 가공품'], [/stainless/i, '스테인리스'], [/wind towers?/i, '풍력 타워'], [/oil country tubular|octg/i, '유정용 강관'], [/line pipe/i, '송유관'], [/pipe|tube|tubular/i, '강관'], [/nails?\b/i, '못'], [/wire\b|strand/i, '와이어'],
  [/forg/i, '단조품'], [/threaded rod/i, '봉강'], [/electrodes?/i, '흑연 전극'],
  [/structural|beam|section/i, '형강'], [/silicon|electrical steel|grain-oriented/i, '전기강판'], [/steel/i, '철강재']
];

function stageOf(t) { for (const [re, id, ko] of STAGES) if (re.test(t)) return { stage: id, stageKo: ko }; return { stage: 'other', stageKo: '공고' }; }
function countriesOf(t) {
  const head = String(t).split(':')[0].replace(/\[uuml\]/g, 'ü'), m = head.match(/\bFrom (?:the )?(.+)$/i);
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

// 법정 기한 추정(공고일 기준): 연례 재심 예비→최종 120일, 원심 예비→최종 75일(연기 시 135일), 개시→예비 AD 140일·CVD 65일.
function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function statutory(t, stage, pub) {
  if (!pub) return null;
  const tl = t.toLowerCase();
  if (/postponement of preliminary/.test(tl)) return null;
  if (stage === 'prelim') {
    if (/preliminary results/.test(tl)) return { date: addDays(pub, 120), what: '최종 판정 예정' };
    if (/preliminary (affirmative|negative)/.test(tl)) return { date: addDays(pub, /postponement of final/.test(tl) ? 135 : 75), what: '최종 판정 예정' };
  }
  if (stage === 'init') {
    if (/less-than-fair-value|antidumping/.test(tl)) return { date: addDays(pub, 140), what: '예비 판정 예정' };
    if (/countervailing/.test(tl)) return { date: addDays(pub, 65), what: '예비 판정 예정' };
  }
  return null;
}

function shape(r, today) {
  const t = String(r.title || '').trim(), st = stageOf(t), cs = countriesOf(t), prod = productOf(t);
  const ko = cs.map(countryKo);
  const dl = deadlinesOf([r.dates, r.abstract].filter(Boolean).join(' '), today);
  if (r.comments_close_on && r.comments_close_on > today && !dl.some(x => x.date === r.comments_close_on)) dl.unshift({ date: r.comments_close_on, what: '의견 제출 마감' });
  const est = statutory(t, st.stage, r.publication_date);
  if (est && est.date > today && !dl.some(x => x.what === est.what)) dl.push(Object.assign(est, { est: true }));
  dl.sort((x, y) => x.date.localeCompare(y.date));
  return { steel: isSteel(prod, t), id: r.document_number || r.html_url, date: r.publication_date, title: t, url: /^https?:\/\//.test(r.html_url || '') ? r.html_url : null,
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
    const items = (j.results || []).map(r => shape(r, today)).filter(x => x.url && x.title && x.steel && x.stage !== 'admin').map(x => { delete x.steel; return x; });
    const upcoming = [];
    items.forEach(x => x.deadlines.forEach(d => upcoming.push({ date: d.date, what: d.what, est: !!d.est, productKo: x.productKo, countriesKo: x.countriesKo, korea: x.korea, stageKo: x.stageKo, url: x.url, id: x.id })));
    upcoming.sort((a, b) => a.date.localeCompare(b.date));
    // 같은 품목·나라의 반덤핑/상계관세 공고가 같은 날 겹치면 한 줄로
    const seen = new Set();
    for (let i = upcoming.length - 1; i >= 0; i--) { const u = upcoming[i], k = [u.date, u.what, u.productKo, u.countriesKo.join('|')].join('/'); if (seen.has(k)) upcoming.splice(i, 1); else seen.add(k); }
    return { status: 'ok', updatedAt: now().toISOString(), source: 'Federal Register (U.S. Department of Commerce, ITA)', count: items.length, items, upcoming: upcoming.slice(0, 30) };
  }
  return {
    async get() {
      if (mem && mem.exp > Date.now()) return mem.v;
      const k = 'remedies:v2';
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

module.exports = { createRemedies, shape, stageOf, countriesOf, productOf, productKo, deadlinesOf, isSteel, statutory };
