'use strict';
// 시장 노트: 수입국 × 품목별 통상 환경(관세·특례 제도·무역구제·원산지 규정). 편집부가 확인한 내용만 싣는다.
// 기본값(DEFAULTS)은 코드에 두고, 관리자 화면에서 고친 내용은 KV 'hsnotes:v1'에 저장해 기본값을 덮어쓴다.
// 각 노트: { id, market, codes:[HS 앞자리], title, body, sources:[{title,url}], checkedAt }
const KEY = 'hsnotes:v1';
const DEFAULTS = [
  { id: 'mx-tariff-2026', market: 'MX', codes: ['72', '73'], title: 'FTA 미체결국 관세 인상 (중국·한국 포함)',
    body: '멕시코 의회가 2025년 12월 FTA를 맺지 않은 국가(중국·한국·인도 등)에서 들어오는 여러 품목의 수입 관세를 최대 50%까지 올리는 법 개정을 승인했고, 철강 제품이 포함됩니다. 한국과 중국 모두 멕시코와 FTA가 없어 같은 세율 체계를 적용받습니다. 품목별 실제 세율(예: 7210.12)은 멕시코 관세표(TIGIE) 해당 세번에서 확인해야 합니다.',
    sources: [{ title: 'Thomson Reuters — Mexico approves tariff hikes on imports from China (2025-12)', url: 'https://www.thomsonreuters.com/en-us/help/onesource-global-trade/regulatory-insights/2025/december-15th/mexico-approves-tariff-hikes-on-imports-from-china.html' }, { title: 'Mexico Business News — Mexico Imposes 50% Tariffs on Non-FTA Imports', url: 'https://mexicobusiness.news/trade-and-investment/news/mexico-imposes-50-tariffs-non-fta-imports' }],
    checkedAt: '2026-10-15' },
  { id: 'mx-immex-prosec', market: 'MX', codes: ['72', '73'], title: '관세 부담을 줄이는 제도: IMMEX·PROSEC',
    body: 'IMMEX는 수출용 제품 생산에 쓰는 원자재를 관세 없이 임시 수입하는 보세 가공 제도이고, PROSEC은 등록된 제조업체가 지정 업종(철강·포장재 등)의 원자재를 낮은 특혜 세율로 수입하는 제도입니다. 따라서 일반 세율이 높아도 실제 부담은 수입업체의 등록 여부에 따라 크게 다릅니다. 수입 통계에는 이 제도를 거친 물량도 함께 잡힙니다.',
    sources: [], checkedAt: '2026-10-15' }
];

function applies(note, market, codes) {
  if (note.market !== market) return false;
  return (codes || []).some(c => note.codes.some(p => String(c).startsWith(p) || String(p).startsWith(c)));
}

function createHsNotes(opts) {
  const kv = opts.kv;
  async function all() { const saved = await kv.get(KEY).catch(() => null); return Array.isArray(saved) ? saved : DEFAULTS; }
  return {
    all,
    async forQuery(market, codes) { return (await all()).filter(n => applies(n, market, codes)); },
    async save(list) {
      const s = (v, n) => String(v == null ? '' : v).slice(0, n);
      const clean = (Array.isArray(list) ? list : []).slice(0, 60).map((n, i) => ({ id: s(n.id || 'note-' + Date.now() + '-' + i, 60), market: s(n.market, 2).toUpperCase(), codes: (Array.isArray(n.codes) ? n.codes : String(n.codes || '').split(/[\s,]+/)).map(c => String(c).replace(/\D/g, '')).filter(c => c.length >= 2).slice(0, 10), title: s(n.title, 120), body: s(n.body, 1500), sources: (Array.isArray(n.sources) ? n.sources : []).filter(x => x && /^https?:\/\//i.test(x.url)).slice(0, 5).map(x => ({ title: s(x.title, 200), url: s(x.url, 500) })), checkedAt: /^\d{4}-\d{2}-\d{2}$/.test(n.checkedAt) ? n.checkedAt : new Date().toISOString().slice(0, 10) })).filter(n => n.market && n.codes.length && n.title && n.body);
      await kv.set(KEY, clean);
      return clean;
    }
  };
}

module.exports = { createHsNotes, applies, DEFAULTS };
