'use strict';
// 한국 무역위원회(KTC) 철강 반덤핑 사건 타임라인 + 공급사별 세율.
// 공식 API가 없어 확인된 사실을 사건별로 정리해 두고(SEED), 관리자가 화면에서 고쳐 저장할 수 있게 한다(KV 'krrem:v1').
// 각 사건은 출처 링크와 확인일을 함께 가진다. 확정되지 않은 일정은 est: true(예상)로 표시한다.
//  GET /api/kr-remedies → { status, verifiedAt, cases: [...], upcoming: [...] }
const KEY = 'krrem:v1';

// 공급사별 세율: { origin, supplier, rate(%), undertaking(가격약속: 최저가격 이상 수출 시 관세 면제) }
const SEED = [
  {
    id: 'kr-hr', item: 'hr', productKo: '열연', product: '탄소강 및 그 밖의 합금강 열간압연 제품', origins: ['일본', '중국'],
    status: 'order', statusKo: '부과 확정 단계',
    rateText: '일본 31.58~33.43% · 중국 28.16~33.10%',
    rates: [
      { origin: '일본', supplier: '가격약속 업체 (JFE·닛폰제철·도쿄제철)', rate: 0, undertaking: true },
      { origin: '중국', supplier: '가격약속 업체 (바오산·번강 등 6개사)', rate: 0, undertaking: true },
      { origin: '일본', supplier: '그 밖의 공급자 (범위 상단)', rate: 33.43 },
      { origin: '중국', supplier: '그 밖의 공급자 (범위 상단)', rate: 33.10 }
    ],
    undertaking: '9개사(최근 3년 수입의 약 81%)가 5년간 최저수출가격 이상 수출을 약속',
    events: [
      { date: '2025-03-04', kind: 'init', label: '조사 개시' },
      { date: '2025-07-24', kind: 'prelim', label: '예비 판정' },
      { date: '2025-09-23', kind: 'provisional', label: '잠정관세 시행' },
      { date: '2026-02-23', kind: 'final', label: '무역위 최종 판정 (부과 건의)' },
      { date: '2026-05-26', kind: 'notice', label: '부과 규칙 입법예고' }
    ],
    notes: ['업체별 확정 세율은 부과 규칙 별표 기준입니다. 공개 보도는 범위만 전합니다.'],
    sources: [{ title: '페로타임즈 · 日·中 열연 28.16%~33.43% 반덤핑관세', url: 'https://www.ferrotimes.com/news/articleView.html?idxno=46498' }, { title: '철강금속신문 · 中·日 열연강판 반덤핑 규칙 입법예고', url: 'https://www.snmnews.com/news/articleView.html?idxno=569790' }]
  },
  {
    id: 'kr-plate', item: 'plate', productKo: '후판', product: '탄소강 및 그 밖의 합금강 열간압연 후판 (6mm 이상)', origins: ['중국'],
    status: 'order', statusKo: '부과 중',
    rateText: '27.91~34.10%',
    rates: [
      { origin: '중국', supplier: '가격약속 업체 (바오산·사강·화링샹탄 등 9개사)', rate: 0, undertaking: true },
      { origin: '중국', supplier: '그 밖의 공급자', rate: 34.10 }
    ],
    undertaking: '9개 수출자가 강종별 최저가격(CFR) 이상 수출을 약속. 조선용 보세 후판은 제외',
    events: [
      { date: '2024-10-04', kind: 'init', label: '조사 개시' },
      { date: '2025-02-20', kind: 'prelim', label: '예비 판정 (27.91~38.02%)' },
      { date: '2025-04-24', kind: 'provisional', label: '잠정관세 시행' },
      { date: '2025-08-28', kind: 'final', label: '무역위 최종 판정 (최대 34.10%, 5년)' }
    ],
    notes: [],
    sources: [{ title: '철강금속신문 · 中 후판 최대 34.1% 반덤핑 관세', url: 'https://www.snmnews.com/news/articleView.html?idxno=557321' }]
  },
  {
    id: 'kr-coated', item: 'coated', productKo: '도금·컬러강판', product: '아연·아연합금 표면처리 냉연강판 (4.75mm 미만, EGI·GA 제외)', origins: ['중국'],
    status: 'provisional', statusKo: '잠정관세 중',
    rateText: '22.34~33.67% (잠정)',
    rates: [
      { origin: '중국', supplier: '내몽골 바오터우강철연합', rate: 22.34 },
      { origin: '중국', supplier: '서우강징탕', rate: 26.28 },
      { origin: '중국', supplier: '윈스톤 디벨롭먼트', rate: 33.67 },
      { origin: '중국', supplier: '그 밖의 공급자', rate: 25.75 }
    ],
    events: [
      { date: '2025-11-28', kind: 'init', label: '조사 개시' },
      { date: '2026-04-16', kind: 'prelim', label: '예비 판정' },
      { date: '2026-06-12', kind: 'provisional', label: '잠정관세 시행' },
      { date: '2027-01-11', kind: 'expiry', label: '잠정관세 종료 (연장)' }
    ],
    notes: ['조사기간 연장으로 잠정관세가 2027년 1월 11일까지 이어집니다. 최종 판정 일정은 미정입니다.'],
    sources: [{ title: '철강금속신문 · 中 도금강판 잠정관세 시행', url: 'https://www.snmnews.com/news/articleView.html?idxno=570645' }, { title: '철강금속신문 · 잠정관세 내년 1월까지 연장', url: 'https://www.snmnews.com/news/articleView.html?idxno=575634' }]
  },
  {
    id: 'kr-sbq', item: 'bar', productKo: '특수강 봉강', product: '특수강 봉강', origins: ['중국'],
    status: 'prelim', statusKo: '예비 판정',
    rateText: '25.08~27.96% (예비)',
    rates: [{ origin: '중국', supplier: '예비 판정 범위 상단', rate: 27.96 }],
    events: [
      { date: '2026-05-07', kind: 'init', label: '조사 개시' },
      { date: '2026-09-17', kind: 'prelim', label: '예비 판정 · 잠정관세 건의' },
      { date: '2026-11-18', kind: 'provisional', label: '잠정관세 시행', est: true, why: '최근 5건 평균(예비 판정 후 62일)' },
      { date: '2027-02-15', kind: 'final', label: '최종 판정', est: true, why: '12월 공청회 후 2월 예정 보도' }
    ],
    notes: ['잠정관세 시행일은 재정경제부 결정·고시에 따라 달라집니다. 과거 사례 범위로는 11월 13~24일입니다.'],
    sources: [{ title: '머니투데이 · 쏟아지는 중국산 저가 철강…관세장벽 높이는 韓', url: 'https://www.mt.co.kr/article/2026092308125121684' }]
  },
  {
    id: 'kr-hbeam', item: 'section', productKo: 'H형강', product: 'H형강', origins: ['중국'],
    status: 'sunset', statusKo: '연장 건의',
    rateText: '28.23~32.72%',
    rates: [{ origin: '중국', supplier: '범위 상단', rate: 32.72 }],
    events: [
      { date: '2014-07-24', kind: 'init', label: '최초 조사 개시' },
      { date: '2026-09-17', kind: 'sunset', label: '2차 재심 · 5년 연장과 가격약속 건의' }
    ],
    notes: ['10년 넘게 이어진 조치입니다. 연장 확정은 재정경제부 규칙 개정으로 이뤄집니다.'],
    sources: [{ title: '머니투데이 · 관세장벽 높이는 韓', url: 'https://www.mt.co.kr/article/2026092308125121684' }]
  },
  {
    id: 'kr-sts-plate', item: 'sts', productKo: 'STS 후판', product: '스테인리스 후판 (4.75mm 이상, 폭 600mm 이상)', origins: ['중국'],
    status: 'order', statusKo: '부과 중',
    rateText: '21.62%',
    rates: [{ origin: '중국', supplier: '모든 공급자', rate: 21.62 }],
    events: [
      { date: '2024-09-06', kind: 'init', label: '조사 개시' },
      { date: '2025-01-16', kind: 'prelim', label: '예비 판정' },
      { date: '2025-03-25', kind: 'provisional', label: '잠정관세 시행' },
      { date: '2025-06-26', kind: 'final', label: '무역위 최종 판정 (5년)' }
    ],
    notes: [],
    sources: [{ title: '서울경제 · 中 스테인리스 후판 반덤핑관세 확정', url: 'https://www.sedaily.com/article/14083992' }]
  },
  {
    id: 'kr-sts-cr-vn', item: 'sts', productKo: 'STS 냉연', product: '스테인리스강 냉간압연 제품', origins: ['베트남'],
    status: 'order', statusKo: '부과 중',
    rateText: '11.37~18.81%',
    rates: [{ origin: '베트남', supplier: '범위 상단', rate: 18.81 }],
    events: [
      { date: '2024-05-30', kind: 'init', label: '조사 개시' },
      { date: '2024-10-17', kind: 'prelim', label: '예비 판정' },
      { date: '2024-12-19', kind: 'provisional', label: '잠정관세 시행' },
      { date: '2025-04-24', kind: 'final', label: '무역위 최종 판정 (5년)' }
    ],
    notes: [],
    sources: [{ title: '경북매일 · 베트남산 스테인리스 냉연 반덤핑', url: 'https://kbmaeil.com/article/20250425500002' }]
  },
  {
    id: 'kr-sts-flat', item: 'sts', productKo: 'STS 평판압연재', product: '스테인리스강 평판압연재 (8mm 이하, 일부 강종 제외)', origins: ['중국', '인도네시아', '대만'],
    status: 'order', statusKo: '재심 후 연장',
    rateText: '9.07~25.82%',
    rates: [
      { origin: '중국', supplier: '가격약속 업체 (산시타이강·리스코 등)', rate: 0, undertaking: true },
      { origin: '중국', supplier: '그 밖의 공급자', rate: 24.83 },
      { origin: '인도네시아', supplier: '가격약속 업체 (칭산 등)', rate: 0, undertaking: true },
      { origin: '인도네시아', supplier: '그 밖의 공급자', rate: 25.82 },
      { origin: '대만', supplier: '가격약속 업체 (유스코·월신)', rate: 0, undertaking: true },
      { origin: '대만', supplier: '그 밖의 공급자', rate: 9.07 }
    ],
    undertaking: '개별 조사 업체는 수출가격 인상 약속으로 관세 대신 모니터링',
    events: [
      { date: '2021-09-15', kind: 'order', label: '최초 부과' },
      { date: '2024-09-14', kind: 'sunset', label: '일몰 재심 → 5년 연장' }
    ],
    notes: [],
    sources: [{ title: '다음 · 중국·인니·대만産 STS 반덤핑 재심 결과', url: 'https://v.daum.net/v/BPqTd4meeh' }]
  }
];
const VERIFIED = '2026-10-16';

function clean(cases) {
  if (!Array.isArray(cases)) throw Object.assign(new Error('cases must be array'), { code: 'bad_cases' });
  return cases.slice(0, 60).map(c => {
    if (!c || !c.id || !c.productKo) throw Object.assign(new Error('id/productKo required'), { code: 'bad_cases' });
    const ev = (c.events || []).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date || '')).map(e => ({ date: e.date, kind: String(e.kind || 'notice'), label: String(e.label || '').slice(0, 80), est: !!e.est, why: e.why ? String(e.why).slice(0, 80) : undefined }));
    const rates = (c.rates || []).filter(r => r && r.supplier != null && isFinite(Number(r.rate))).map(r => ({ origin: String(r.origin || ''), supplier: String(r.supplier).slice(0, 80), rate: Number(r.rate), undertaking: !!r.undertaking }));
    const src = (c.sources || []).filter(s => s && /^https?:\/\//.test(s.url || '')).map(s => ({ title: String(s.title || s.url).slice(0, 100), url: s.url }));
    return Object.assign({}, c, { events: ev.sort((a, b) => a.date.localeCompare(b.date)), rates, sources: src, origins: (c.origins || []).map(String), notes: (c.notes || []).map(String) });
  });
}

function upcomingOf(cases, today) {
  const out = [];
  cases.forEach(c => (c.events || []).forEach(e => { if (e.date > today) out.push({ date: e.date, label: e.label, est: !!e.est, why: e.why || null, id: c.id, productKo: c.productKo, origins: c.origins }); }));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function createKrRemedies(opts) {
  const kv = opts && opts.kv, now = (opts && opts.now) || (() => new Date());
  const today = () => new Date(now().getTime() + 9 * 3600000).toISOString().slice(0, 10);
  async function current() {
    const saved = kv ? await kv.get(KEY).catch(() => null) : null;
    return saved && Array.isArray(saved.cases) ? { cases: saved.cases, verifiedAt: saved.verifiedAt || VERIFIED, edited: true } : { cases: SEED, verifiedAt: VERIFIED, edited: false };
  }
  return {
    async get() {
      const c = await current(), t = today();
      const cases = c.cases.map(x => Object.assign({}, x, { last: (x.events || []).filter(e => e.date <= t).slice(-1)[0] || null, next: (x.events || []).filter(e => e.date > t)[0] || null }));
      return { status: 'ok', verifiedAt: c.verifiedAt, edited: c.edited, source: '무역위원회·재정경제부 발표와 업계 보도 정리', cases, upcoming: upcomingOf(cases, t) };
    },
    async adminGet() { return current(); },
    async save(cases, verifiedAt) {
      const v = { cases: clean(cases), verifiedAt: /^\d{4}-\d{2}-\d{2}$/.test(verifiedAt || '') ? verifiedAt : today(), savedAt: new Date().toISOString() };
      if (kv) await kv.set(KEY, v);
      return { ok: true, count: v.cases.length, verifiedAt: v.verifiedAt };
    },
    async reset() { if (kv) await kv.set(KEY, null); return { ok: true }; }
  };
}

module.exports = { createKrRemedies, SEED, clean, upcomingOf };
