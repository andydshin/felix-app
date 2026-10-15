'use strict';
// HS 코드 무역 검색: "어느 시장이(수입국) 어느 나라에서(상대국) 이 품목을 얼마나, 얼마에 들여오나"
//  ① UN Comtrade (수입국이 신고한 월별 통계, CIF) — 멕시코·미국·베트남 등 아무 나라나. 키: 환경변수 COMTRADE_API_KEY
//     키가 없으면 공개 미리보기 API(건수 제한)로 시도한다.
//  ② 관세청 품목별 국가별 수출입실적 — 한국 기준(한국→상대국 수출 FOB, 상대국→한국 수입 CIF). 키: CUSTOMS_SERVICE_KEY
// 키는 서버 환경변수에서만 읽고, 응답·로그에는 넣지 않는다.
const { query: customsQuery } = require('./customs');
const { createNews } = require('./news');
const { compose } = require('./hsarticle');

const COMTRADE = process.env.COMTRADE_BASE || 'https://comtradeapi.un.org';
// ISO2 → UN M49
const M49 = { WD: 0, CN: 156, KR: 410, JP: 392, US: 842, MX: 484, VN: 704, IN: 699, TW: 490, DE: 276, ID: 360, TH: 764, BR: 76, CA: 124, TR: 792, MY: 458 };
const NAME = { WD: '전체', CN: '중국', KR: '한국', JP: '일본', US: '미국', MX: '멕시코', VN: '베트남', IN: '인도', TW: '대만', DE: '독일', ID: '인도네시아', TH: '태국', BR: '브라질', CA: '캐나다', TR: '튀르키예', MY: '말레이시아' };
const PRESETS = {
  tinplate: { name: '석도강판', codes: ['721011', '721012', '721210'], note: '7210.11 두께 0.5mm 이상 · 7210.12 0.5mm 미만 · 7212.10 폭 600mm 미만' },
  hr: { name: '열연', codes: ['7208'] }, cr: { name: '냉연', codes: ['7209'] }, coated: { name: '도금강판', codes: ['721049', '721041', '721070'] },
  plate: { name: '후판', codes: ['720851', '720852'] }, rebar: { name: '철근', codes: ['721420'] }, sts: { name: '스테인리스 판재', codes: ['7219'] }
};
const TTL = 12 * 3600;
// 관련 뉴스 검색어: 품목(영·스페인·한국어) × 시장
const TOPIC = {
  tinplate: { en: '(tinplate OR "tin plate" OR "tin mill")', es: 'hojalata', ko: '석도강판', name: '석도강판' },
  hr: { en: '("hot-rolled" OR "hot rolled coil" OR HRC)', es: '"lámina rolada en caliente"', ko: '열연', name: '열연' },
  cr: { en: '("cold-rolled" OR "cold rolled coil" OR CRC)', es: '"rolada en frío"', ko: '냉연', name: '냉연' },
  coated: { en: '(galvanized OR "coated steel")', es: 'galvanizada', ko: '도금강판', name: '도금강판' },
  plate: { en: '("steel plate" OR "heavy plate")', es: '"placa de acero"', ko: '후판', name: '후판' },
  rebar: { en: 'rebar', es: 'varilla', ko: '철근', name: '철근' },
  sts: { en: '"stainless steel"', es: '"acero inoxidable"', ko: '스테인리스', name: '스테인리스' },
  steel: { en: 'steel', es: 'acero', ko: '철강', name: '철강재' }
};
const MKT_WORDS = { MX: ['Mexico', 'México', '멕시코'], US: ['"United States"', 'Estados Unidos', '미국'], VN: ['Vietnam', 'Vietnam', '베트남'], IN: ['India', 'India', '인도'], JP: ['Japan', 'Japón', '일본'], KR: ['Korea', 'Corea', '한국'] };
function topicOf(preset, codes) {
  if (TOPIC[preset]) return preset;
  const c = (codes || [])[0] || '';
  if (/^72101[12]|^721210/.test(c)) return 'tinplate';
  if (/^7208/.test(c)) return 'hr'; if (/^7209/.test(c)) return 'cr'; if (/^7210[4-9]|^7212[3-6]/.test(c)) return 'coated';
  if (/^72085[12]/.test(c)) return 'plate'; if (/^7214/.test(c)) return 'rebar'; if (/^7219|^7220/.test(c)) return 'sts';
  return 'steel';
}
function newsQueries(topicKey, market) {
  const t = TOPIC[topicKey], m = MKT_WORDS[market] || [market, market, market];
  return [t.en + ' (' + m[0] + ' OR ' + m[1] + ') sourcelang:english', t.es + ' ' + m[1] + ' sourcelang:spanish', t.ko + ' ' + m[2] + ' sourcelang:korean'];
}

class HsError extends Error { constructor(status, detail) { super('hs trade failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }
const codesOf = s => [...new Set(String(s || '').split(/[\s,]+/).map(x => x.replace(/\D/g, '')).filter(x => x.length >= 4 && x.length <= 10))].slice(0, 6);
const iso = s => [...new Set(String(s || '').toUpperCase().split(/[\s,]+/).filter(x => x in M49))].slice(0, 6);
function monthsBack(now, n, skip) { const out = []; for (let i = n + (skip || 0) - 1; i >= (skip || 0); i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); out.push(d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0')); } return out; }
const ymDash = p => String(p).slice(0, 4) + '-' + String(p).slice(4, 6);
function redact(s) { const k = process.env.COMTRADE_API_KEY; return k ? String(s).split(k.trim()).join('[redacted]') : String(s); }

// 행 [{ym, code, partner, kg, usd}] → { months, series: { partner: { total: [{ym,t,usd,unit}], byCode: {code: [...]}}}, latest }
function shape(rows, partners, codes) {
  const months = [...new Set(rows.map(r => r.ym))].sort();
  const series = {};
  const pt = (list, ym) => { const a = list.filter(r => r.ym === ym); const kg = a.reduce((s, r) => s + r.kg, 0), usd = a.reduce((s, r) => s + r.usd, 0); return kg > 0 ? { ym, t: Math.round(kg / 100) / 10, usd: Math.round(usd), unit: Math.round(usd / (kg / 1000) * 10) / 10 } : { ym, t: 0, usd: Math.round(usd), unit: null }; };
  partners.forEach(p => {
    const mine = rows.filter(r => r.partner === p);
    series[p] = { name: NAME[p] || p, total: months.map(m => pt(mine, m)), byCode: {} };
    codes.forEach(c => { series[p].byCode[c] = months.map(m => pt(mine.filter(r => r.code.startsWith(c)), m)); });
  });
  // 상대국 합계 대비 비중(전체 WD를 요청한 경우)
  return { months: months.map(ymDash), series };
}


// 데이터로 확인되는 사실만 문장으로 만든다(추정·해석 없음). 숫자는 모두 위 통계에서 계산.
function analyze(out) {
  const M = out.main; if (!M || !M.months.length) return [];
  const facts = [], fmtI = v => Math.round(v).toLocaleString('en-US'), pct = v => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + '%';
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const ps = out.partners.map(p => p.code).filter(p => M.series[p] && p !== 'WD');
  const W = M.series.WD, n = M.months.length, mkt = out.marketName;
  const stat = {};
  ps.forEach(p => {
    const t = M.series[p].total, T = sum(t, x => x.t), U = sum(t, x => x.usd);
    const last3 = t.slice(-3), prev3 = t.slice(-6, -3);
    const l3 = sum(last3, x => x.t), p3 = sum(prev3, x => x.t);
    const lu = l3 ? sum(last3, x => x.usd) / l3 : null, pu = p3 ? sum(prev3, x => x.usd) / p3 : null;
    const wT = W ? sum(W.total, x => x.t) : null;
    const vols = t.map(x => x.t), mean = T / (vols.length || 1);
    const cv = mean ? Math.sqrt(vols.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (vols.length || 1)) / mean : null;
    const zero = vols.filter(v => !v).length;
    const codesMix = out.codes.map(c => ({ c, t: sum(M.series[p].byCode[c] || [], x => x.t) })).filter(x => x.t > 0).sort((a, b) => b.t - a.t);
    stat[p] = { name: M.series[p].name, T, unit: T ? U / T : null, share: wT ? T / wT * 100 : null, l3, p3, lu, pu, cv, zero, codesMix,
      dv: p3 ? (l3 - p3) / p3 * 100 : null, du: lu && pu ? (lu - pu) / pu * 100 : null };
  });
  const nm = p => stat[p].name + '산';
  const active = ps.filter(p => stat[p].T > 0).sort((a, b) => stat[b].T - stat[a].T);

  // 1. 규모와 점유율 + 시장 구조 해석
  if (W) {
    const wT = sum(W.total, x => x.t), top = active[0];
    let insight = '';
    if (top && stat[top].share >= 40) insight = nm(top) + '이 전체의 ' + Math.round(stat[top].share) + '%를 차지해 사실상 기준 공급원입니다. ' + mkt + ' 시장 가격은 ' + nm(top) + ' 오퍼에 끌려갈 가능성이 큽니다.';
    else if (top) insight = '상위 공급국 점유율이 ' + Math.round(stat[top].share) + '%로, 한 나라가 가격을 좌우하는 구조는 아닙니다.';
    const others = W && active.length ? 100 - active.reduce((a, p) => a + (stat[p].share || 0), 0) : null;
    if (others != null && others > 30) insight += ' 고른 상대국 외 다른 나라가 ' + Math.round(others) + '%를 채우고 있어, 대만·일본·베트남 등도 함께 볼 필요가 있습니다.';
    facts.push({ kind: 'volume', title: '시장 규모와 점유율', text: mkt + '의 최근 ' + n + '개월 수입 합계는 ' + fmtI(wT) + 't (연간 환산 약 ' + fmtI(wT / n * 12) + 't). ' + active.map(p => nm(p) + ' ' + fmtI(stat[p].T) + 't(' + (Math.round(stat[p].share * 10) / 10) + '%)').join(', ') + '.', insight });
  }

  // 2. 최근 3개월 흐름 + 물량·단가 조합 해석
  const tr = active.filter(p => stat[p].dv != null);
  if (tr.length) {
    const read = p => {
      const v = stat[p].dv, u = stat[p].du;
      if (u == null) return null;
      if (v > 10 && u < -1) return nm(p) + ': 물량↑·단가↓ → 저가로 물량을 밀어내는 흐름으로 추정';
      if (v > 10 && u > 1) return nm(p) + ': 물량↑·단가↑ → 수요가 받쳐 주는 흐름으로 추정';
      if (v < -10 && u > 1) return nm(p) + ': 물량↓·단가↑ → 가격을 지키며 물량을 내주는 흐름(또는 고급재 비중 증가)으로 추정';
      if (v < -10 && u < -1) return nm(p) + ': 물량↓·단가↓ → 수요 둔화나 무역 조치 영향 가능성';
      if (v > 10) return nm(p) + ': 단가는 그대로인데 물량↑ → 수요 증가나 점유율 확대로 추정';
      if (v < -10) return nm(p) + ': 단가는 그대로인데 물량↓ → 수요 감소나 다른 공급국으로의 이동으로 추정';
      if (u > 3) return nm(p) + ': 물량은 비슷하고 단가↑ → 원가·오퍼 인상이 반영되는 중으로 추정';
      if (u < -3) return nm(p) + ': 물량은 비슷하고 단가↓ → 오퍼 인하나 저가 규격 비중 증가로 추정';
      return nm(p) + ': 큰 변화 없음';
    };
    facts.push({ kind: 'trend', title: '최근 3개월 흐름', text: '직전 3개월 대비 ' + tr.map(p => nm(p) + ' 물량 ' + pct(stat[p].dv) + (stat[p].du != null ? ', 단가 ' + pct(stat[p].du) : '')).join(' / ') + '. (' + M.months.slice(-3)[0] + '~' + M.months[n - 1] + ' 기준)', insight: tr.map(read).filter(Boolean).join(' · ') });
  }

  // 3. 단가 격차 + 경쟁 구도 해석
  const priced = active.filter(p => stat[p].unit);
  if (priced.length >= 2) {
    const sorted = priced.slice().sort((a, b) => stat[a].unit - stat[b].unit), lo = sorted[0], hi = sorted[sorted.length - 1];
    const gap = stat[hi].unit - stat[lo].unit, gp = gap / stat[lo].unit * 100;
    let insight = '';
    if (gp >= 10) {
      const hiHolds = stat[hi].dv == null || stat[hi].dv > -10;
      insight = hiHolds ? nm(hi) + '은 ' + Math.round(gp) + '% 비싸도 물량이 유지되고 있어, 가격보다 품질·규격·납기·장기계약으로 팔리는 시장으로 추정됩니다.' : nm(hi) + '은 가격 차이가 ' + Math.round(gp) + '%로 벌어진 가운데 물량이 줄고 있어, 가격 경쟁력 부담이 나타나는 것으로 추정됩니다.';
      if (stat[lo].du != null && stat[hi].du != null) insight += ' 최근 3개월 격차는 ' + (stat[hi].du - stat[lo].du > 1 ? '벌어지는' : (stat[hi].du - stat[lo].du < -1 ? '좁혀지는' : '비슷한')) + ' 중입니다.';
    } else insight = '두 나라 단가 차이가 10% 미만이라 같은 등급 제품끼리 가격으로 경쟁하는 구도로 보입니다.';
    facts.push({ kind: 'price', title: '단가 격차 (' + n + '개월 평균, CIF)', text: priced.map(p => nm(p) + ' $' + fmtI(stat[p].unit) + '/t').join(', ') + '. ' + nm(hi) + '이 ' + nm(lo) + '보다 톤당 $' + fmtI(gap) + ' (' + Math.round(gp) + '%) 비쌉니다.', insight });
  }

  // 4. 거래 방식 추정: 월별 물량의 들쭉날쭉한 정도(변동계수)
  const cvs = active.filter(p => stat[p].cv != null && n >= 6);
  if (cvs.length) {
    facts.push({ kind: 'pattern', title: '거래 방식 추정 (월별 물량의 안정성)', text: cvs.map(p => nm(p) + ' 변동계수 ' + (Math.round(stat[p].cv * 100) / 100) + (stat[p].zero ? ', 수입 없는 달 ' + stat[p].zero + '개월' : '')).join(' / ') + '.',
      insight: cvs.map(p => nm(p) + (stat[p].cv < 0.35 ? '은 매달 고르게 들어와 정기 계약 물량 중심으로 추정' : (stat[p].cv < 0.7 ? '은 중간 정도로 출렁여 계약과 현물이 섞인 것으로 추정' : '은 달마다 크게 출렁여 현물(스팟)·선적 묶음 중심으로 추정'))).join(' · ') + '. (변동계수 = 월 물량 표준편차 ÷ 평균)' });
  }

  // 5. 관세 인상 전후 비교 (멕시코: 2026-01 시행)
  if (out.market === 'MX') {
    const pre = M.months.filter(m => m >= '2025-10' && m <= '2025-12'), post = M.months.filter(m => m >= '2026-01').slice(0, 6);
    if (pre.length >= 2 && post.length >= 3) {
      const avg = (p, ms) => { const s = M.series[p].total.filter(x => ms.includes(x.ym.slice(0, 4) + '-' + x.ym.slice(4))); return s.length ? sum(s, x => x.t) / s.length : 0; };
      const rows = active.map(p => { const a = avg(p, pre), b = avg(p, post); return { p, a, b, d: a ? (b - a) / a * 100 : null }; }).filter(r => r.d != null);
      if (rows.length) facts.push({ kind: 'policy', title: '관세 인상 전후 (2026-01 시행 기준)', text: '월평균 물량: ' + rows.map(r => nm(r.p) + ' ' + fmtI(r.a) + 't → ' + fmtI(r.b) + 't (' + pct(r.d) + ')').join(' / ') + '. 비교 구간: ' + pre[0] + '~' + pre[pre.length - 1] + ' vs ' + post[0] + '~' + post[post.length - 1] + '.',
        insight: (rows.length >= 2 && Math.max(...rows.map(r => r.d)) - Math.min(...rows.map(r => r.d)) > 20) ? (function () { const up = rows.slice().sort((x, y) => y.d - x.d)[0], dn = rows.slice().sort((x, y) => x.d - y.d)[0]; return '같은 관세를 받는데도 ' + nm(up.p) + '은 ' + pct(up.d) + ', ' + nm(dn.p) + '은 ' + pct(dn.d) + '로 엇갈렸습니다. 관세보다 가격 경쟁력이나 수입업체의 감면 제도(IMMEX·PROSEC) 활용 차이가 더 크게 작동한 것으로 추정됩니다.'; })() : rows.every(r => r.d > -15) ? '관세 인상 이후에도 물량이 크게 줄지 않았습니다. IMMEX·PROSEC 같은 감면 경로를 통한 수입이 많거나, 인상 전 선수입분이 이어진 것으로 추정됩니다.' : rows.filter(r => r.d <= -15).map(r => nm(r.p)).join('·') + ' 물량이 눈에 띄게 줄었습니다. 관세 인상이 실제 수입 감소로 이어진 것으로 추정되며, 대체 공급국이 어디인지 함께 볼 필요가 있습니다.' });
    }
  }

  // 6. 세부 코드 구성
  const CODE_DESC = { '721012': '두께 0.5mm 미만', '721011': '두께 0.5mm 이상', '721210': '폭 600mm 미만', '7208': '열연', '7209': '냉연' };
  const mix = active.filter(p => stat[p].codesMix.length > 1);
  if (mix.length) {
    const lead = p => { const c = stat[p].codesMix[0]; return { c: c.c, sh: c.t / stat[p].T }; };
    let insight = mix.map(p => nm(p) + '은 ' + lead(p).c + (CODE_DESC[lead(p).c] ? '(' + CODE_DESC[lead(p).c] + ')' : '') + ' 비중이 ' + Math.round(lead(p).sh * 100) + '%').join(', ') + '.';
    if (mix.length >= 2) {
      const a2 = stat[mix[0]].codesMix, b2 = stat[mix[1]].codesMix, sh = (list, c, T) => ((list.find(x => x.c === c) || { t: 0 }).t) / T;
      const diff = Math.abs(sh(a2, a2[0].c, stat[mix[0]].T) - sh(b2, a2[0].c, stat[mix[1]].T));
      insight += diff > 0.15 ? ' 두 나라의 규격 구성이 달라, 단가 격차의 일부는 두께·폭 차이에서 오는 것으로 볼 수 있습니다.' : ' 두 나라의 규격 구성이 비슷해, 단가 격차는 규격보다 품질·브랜드·거래 조건 차이로 보는 게 맞습니다.';
    }
    facts.push({ kind: 'mix', title: '세부 코드 구성', text: mix.map(p => nm(p) + '은 ' + stat[p].codesMix.map(x => x.c + ' ' + Math.round(x.t / stat[p].T * 100) + '%').join(', ')).join(' / ') + '.', insight });
  }

  // 7. 교차 확인
  if (out.koreaExport && out.koreaExport.series.KR && M.series.KR) {
    const k = out.koreaExport.series.KR.total, m = M.series.KR.total;
    const common = m.filter(x => x.t > 0 && k.some(y => y.ym === x.ym && y.t > 0)).map(x => x.ym);
    if (common.length >= 3) {
      const kT = sum(k.filter(x => common.includes(x.ym)), x => x.t), kU = sum(k.filter(x => common.includes(x.ym)), x => x.usd), mT = sum(m.filter(x => common.includes(x.ym)), x => x.t), mU = sum(m.filter(x => common.includes(x.ym)), x => x.usd);
      const dvol = (mT - kT) / kT * 100, dpx = mU / mT - kU / kT;
      let insight = Math.abs(dvol) <= 30 ? '두 통계의 물량이 비슷해 한국산 수치는 믿을 만합니다.' : (dvol > 30 ? mkt + '가 신고한 한국산이 한국 통계보다 많습니다. 다른 나라를 거쳐 선적된 한국산, 원산지 표기 차이, 선적·통관 시차가 원인일 수 있습니다.' : '한국 통계가 더 많습니다. ' + mkt + ' 도착 전 다른 나라로 재수출됐거나, 다른 세번으로 신고됐을 가능성이 있습니다.');
      insight += dpx > 0 && dpx < 150 ? ' 단가 차이 $' + fmtI(dpx) + '/t는 해상운임·보험 수준으로 자연스럽습니다.' : (dpx <= 0 ? ' ' + mkt + ' 신고 단가가 오히려 낮아, 가격 조정이나 분류 차이를 의심해 볼 만합니다.' : ' 단가 차이가 운임 수준보다 커서 조건·등급 차이를 확인할 필요가 있습니다.');
      facts.push({ kind: 'cross', title: '한국 통계와 교차 확인', text: '겹치는 ' + common.length + '개월 합계: 한국 신고 수출 ' + fmtI(kT) + 't·$' + fmtI(kU / kT) + '/t(FOB), ' + mkt + ' 신고 한국산 수입 ' + fmtI(mT) + 't·$' + fmtI(mU / mT) + '/t(CIF). 물량 차이 ' + pct(dvol) + ', 단가 차이 $' + fmtI(dpx) + '/t.', insight });
    }
  }
  return facts;
}

function createHsTrade(opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || globalThis.fetch;
  const now = o.now || (() => new Date());
  const kv = o.kv || null;
  const wait = o.wait || (ms => new Promise(r => setTimeout(r, ms)));
  const news = o.news || createNews({ fetch: fetchImpl, wait });

  async function getJson(url, headers) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl && setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetchImpl(url, { headers: Object.assign({ Accept: 'application/json' }, headers || {}), signal: ctl ? ctl.signal : undefined });
      const text = await res.text();
      if (!res.ok) throw new HsError(res.status, redact(text.slice(0, 300)));
      try { return JSON.parse(text); } catch (e) { throw new HsError('invalid-json', redact(text.slice(0, 200))); }
    } catch (e) { if (e instanceof HsError) throw e; throw new HsError(e.name === 'AbortError' ? 'timeout' : 'network', String(e.cause && e.cause.code || e.message)); }
    finally { if (t) clearTimeout(t); }
  }

  // ① Comtrade: reporter의 수입(M) 또는 수출(X)
  async function comtrade(reporter, partners, codes, flow, nMonths) {
    let key = process.env.COMTRADE_API_KEY && process.env.COMTRADE_API_KEY.trim();
    let keyError = null;
    const periods = monthsBack(now(), nMonths || 12, 1);
    const call = async ps => {
      const params = new URLSearchParams({ reporterCode: String(M49[reporter]), period: ps.join(','), partnerCode: partners.map(p => M49[p]).join(','), cmdCode: codes.join(','), flowCode: flow === 'export' ? 'X' : 'M', partner2Code: '0', customsCode: 'C00', motCode: '0', includeDesc: 'false' });
      const j = await getJson(COMTRADE + (key ? '/data/v1/get/C/M/HS?' : '/public/v1/preview/C/M/HS?') + params.toString(), key ? { 'Ocp-Apim-Subscription-Key': key } : null);
      if (j.error) throw new HsError('api', redact(JSON.stringify(j.error).slice(0, 200)));
      return j.data || [];
    };
    // 키가 있으면 한 번에, 거절되거나 키가 없으면(미리보기는 1회 1개월) 달마다 나눠 묻는다. 최신 달부터, 3개씩 동시에.
    let data = [], perMonth = !key, failed = [], fullError = null;
    if (key) {
      try { data = await call(periods); }
      catch (e) {
        fullError = String(e.status) + (e.detail ? ' ' + String(e.detail).slice(0, 160) : '');
        if (String(e.status) === '400' || String(e.status) === '429') { perMonth = true; if (String(e.status) === '429') await wait(3000); }
        // 키가 거절되면(401·403) 키 없이 미리보기로 이어서 받는다
        else if (['401', '403'].includes(String(e.status))) { keyError = String(e.status); key = null; perMonth = true; }
        else throw e;
      }
    }
    if (perMonth) {
      // 미리보기는 요청 빈도 제한이 있다 → 한 번에 하나씩, 1.2초 간격. 429면 3초 쉬고 한 번 더, 또 429면 멈춘다.
      const list = periods.slice().reverse();
      let blocked = false;
      for (let i = 0; i < list.length && !blocked; i++) {
        if (i) await wait(1200);
        try { data.push(...await call([list[i]])); }
        catch (e) {
          if (String(e.status) === '429') {
            await wait(3000);
            try { data.push(...await call([list[i]])); } catch (e2) { failed.push({ period: list[i], status: String(e2.status) }); if (String(e2.status) === '429') blocked = true; }
          } else failed.push({ period: list[i], status: String(e.status) });
        }
      }
      if (!data.length && failed.length) throw new HsError(failed[0].status, '월별 조회가 모두 실패했습니다' + (blocked ? '(요청 한도 초과 — COMTRADE_API_KEY를 넣으면 해결됩니다)' : '') + '.');
    }
    const back = {}; Object.keys(M49).forEach(k => { back[M49[k]] = k; });
    const rows = data.map(r => {
      const kg = Number(r.netWgt) || (/kg/i.test(r.qtyUnitAbbr || '') ? Number(r.qty) : 0) || 0;
      return { ym: String(r.period), code: String(r.cmdCode), partner: back[r.partnerCode] || String(r.partnerCode), kg, usd: Number(r.primaryValue) || Number(flow === 'export' ? r.fobvalue : r.cifvalue) || 0 };
    }).filter(r => r.partner);
    return { source: 'UN Comtrade (' + (NAME[reporter] || reporter) + ' 신고, ' + (flow === 'export' ? 'FOB' : 'CIF') + ')', keyed: !!key, keyError, mode: perMonth ? 'perMonth' : 'single', fullError, count: rows.length, rowsRaw: data.length, failed, rows };
  }

  // ② 관세청: 한국 → 상대국 수출(export) 또는 상대국 → 한국 수입(import)
  async function korea(partner, codes, flow, nMonths) {
    const ps = monthsBack(now(), nMonths || 12, 1);
    const rows = [];
    for (const c of codes) {
      const r = await customsQuery({ strtYymm: ps[0], endYymm: ps[ps.length - 1], hsSgn: c, cntyCd: partner }, fetchImpl);
      r.items.forEach(x => {
        const m = String(x.year || '').match(/^(\d{4})\.(\d{2})$/); if (!m) return;
        if (x.hsCd && !String(x.hsCd).startsWith(c)) return;
        rows.push({ ym: m[1] + m[2], code: String(x.hsCd || c), partner: 'KR', kg: Number(String(flow === 'export' ? x.expWgt : x.impWgt).replace(/,/g, '')) || 0, usd: Number(String(flow === 'export' ? x.expDlr : x.impDlr).replace(/,/g, '')) || 0 });
      });
    }
    return { source: '관세청 (한국 신고, ' + (flow === 'export' ? '수출 FOB' : '수입 CIF') + ')', count: rows.length, rows };
  }

  // 완전한 결과만 저장한다(일부 달이 빠진 결과를 12시간 보여 주지 않도록). fresh면 저장본을 건너뛴다.
  async function cached(k, fn, fresh) {
    if (kv && !fresh) { try { const c = await kv.get(k); if (c && c.exp > Date.now()) return Object.assign({ cache: 'hit' }, c.v); } catch (e) { /* 저장소 오류는 무시 */ } }
    const v = await fn();
    const complete = !v.mainError && !(v.comtradeMeta && v.comtradeMeta.failed && v.comtradeMeta.failed.length);
    if (kv && complete) { try { await kv.set(k, { v, exp: Date.now() + TTL * 1000 }); } catch (e) { /* 무시 */ } }
    return v;
  }

  // 검색: market(수입국) · partners(상대국) · codes
  async function search(q) {
    const preset = PRESETS[q.preset];
    const codes = codesOf(q.codes) .length ? codesOf(q.codes) : (preset ? preset.codes : []);
    const market = iso(q.market)[0] || 'MX';
    const partners = iso(q.partners).length ? iso(q.partners) : ['CN', 'KR'];
    if (!codes.length) throw new HsError('bad_codes', 'HS 코드를 4~10자리 숫자로 넣으세요.');
    const ck = 'hs:v5:' + market + ':' + partners.join('.') + ':' + codes.join('.');
    return cached(ck, async () => {
      const out = { status: 'ok', market, marketName: NAME[market], partners: partners.map(p => ({ code: p, name: NAME[p] })), codes, preset: preset ? { name: preset.name, note: preset.note } : null, fetchedAt: new Date().toISOString() };
      if (market === 'KR') {
        // 한국 수입: 관세청이 가장 빠르고 정확
        const all = [];
        for (const p of partners.filter(p => p !== 'WD')) { const r = await korea(p, codes, 'import', 12); r.rows.forEach(x => { x.partner = p; }); all.push(...r.rows); }
        out.main = Object.assign({ source: '관세청 (한국 수입 신고, CIF)' }, shape(all, partners.filter(p => p !== 'WD'), codes));
      } else {
        const reqP = [...new Set(partners.filter(p => p !== market).concat(['WD']))];
        const tk = topicOf(q.preset, codes);
        out.topicName = TOPIC[tk].name;
        const [ct, kr, nw] = await Promise.allSettled([comtrade(market, reqP, codes, 'import', 12), partners.includes('KR') ? korea(market, codes, 'export', 12) : Promise.resolve(null), news.topic(newsQueries(tk, market), 120)]);
        out.news = nw.status === 'fulfilled' ? nw.value.items : [];
        if (ct.status === 'fulfilled') { out.main = Object.assign({ source: ct.value.source, keyed: ct.value.keyed }, shape(ct.value.rows, reqP, codes)); out.comtradeMeta = { mode: ct.value.mode, fullError: ct.value.fullError, keyError: ct.value.keyError, failed: ct.value.failed, rowsRaw: ct.value.rowsRaw }; }
        else out.mainError = { status: String(ct.reason && ct.reason.status), message: ct.reason && ct.reason.detail };
        if (kr.status === 'fulfilled' && kr.value) out.koreaExport = Object.assign({ source: kr.value.source }, shape(kr.value.rows, ['KR'], codes));
        else if (kr.status === 'rejected') out.koreaError = { status: String(kr.reason && kr.reason.status), message: String(kr.reason && (kr.reason.detail || kr.reason.message) || '') };
      }
      out.facts = analyze(out);
      try { out.article = compose(out, { now: now() }); } catch (e) { out.article = null; }
      return out;
    }, q.fresh === '1' || q.fresh === true);
  }

  // 진단: 응답 구조와 건수
  async function probe() {
    const out = { checkedAt: new Date().toISOString(), comtradeKey: !!process.env.COMTRADE_API_KEY, customsKey: !!process.env.CUSTOMS_SERVICE_KEY };
    try { const r = await comtrade('MX', ['CN', 'KR'], ['721012', '721011', '721210'], 'import', 12); out.comtrade = { ok: true, keyed: r.keyed, mode: r.mode, fullError: r.fullError, keyError: r.keyError, rowsRaw: r.rowsRaw, failed: r.failed, months: [...new Set(r.rows.map(x => x.ym))].sort(), sample: r.rows.slice(0, 4) }; }
    catch (e) { out.comtrade = { ok: false, status: String(e.status), detail: e.detail }; }
    await wait(1500);
    try { const r = await comtrade('MX', ['CN', 'KR', 'WD'], ['721012'], 'import', 12); out.appQuery = { ok: true, keyed: r.keyed, mode: r.mode, fullError: r.fullError, keyError: r.keyError, rowsRaw: r.rowsRaw, failed: r.failed, months: [...new Set(r.rows.map(x => x.ym))].sort(), partners: [...new Set(r.rows.map(x => x.partner))] }; }
    catch (e) { out.appQuery = { ok: false, status: String(e.status), detail: e.detail }; }
    try { const r = await korea('MX', ['721012', '721011', '721210'], 'export', 12); out.korea = { ok: true, rows: r.count, months: [...new Set(r.rows.map(x => x.ym))].sort(), sample: r.rows.slice(0, 4) }; }
    catch (e) { out.korea = { ok: false, status: String(e.status || e.name), detail: String(e.detail || e.message || '') }; }
    return out;
  }

  return { search, probe, comtrade, korea };
}

module.exports = { topicOf, newsQueries, TOPIC, analyze, createHsTrade, shape, codesOf, PRESETS, NAME, M49, HsError };
