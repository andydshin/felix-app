'use strict';
// 가격 방향 신호(향후 1~3개월). 공개 데이터와 Felix 자체 자료를 합쳐 품목별 상승·보합·하락과 확실성을 낸다.
// 예측 모델이 아니라 '선행 신호를 모아 저울질'하는 규칙 기반 점수다. 규칙을 화면에 그대로 보여 주고, 지난 신호의 적중률을 쌓아 공개한다.
//  구성(가중치): 원가 압력 25% · 중국 가격 25% · 제철소 가격 발표 20% · 세계 이슈 15% · 현장 체감 15%
//  각 요소 점수는 -2 ~ +2. 자료가 없는 요소는 빼고 남은 가중치로 다시 나눈다.
//  가격 요소(원가·중국)는 '그 지표의 평소 변동폭 대비 몇 배 움직였나'로 환산한다(1 = 평소만큼).
//   평소 변동폭 = 지표별 사전값(아래 PRIOR)과 Felix 자체 시계열의 실제 변동폭을 섞은 값. 자료가 쌓일수록 실제값 비중이 커진다.
//  표시 단계: ±1 이상 '강한', ±0.35 이상 '우위', 그 안은 보합(±0.15 넘으면 기울기 표시).

const PRODUCTS = [
  { id: 'hr', name: '열연', china: 'cn:hr', mix: 'bf', vote: 'hr', ref: 'kr:hr', items: ['hr'] },
  { id: 'cr', name: '냉연', china: 'cn:hr', mix: 'bf', vote: 'cr', ref: 'kr:cr', items: ['cr', 'hr'] },
  { id: 'coated', name: '도금강판', china: 'cn:hr', mix: 'bf', vote: 'gi', ref: 'kr:coated', items: ['coated', 'cr'] },
  { id: 'plate', name: '후판', china: 'cn:plate', mix: 'bf', vote: null, ref: 'kr:plate', items: ['plate'] },
  { id: 'rebar', name: '철근', china: 'cn:rebar', mix: 'eaf', vote: 'rb', ref: 'kr:rebar', items: ['rebar'] },
  { id: 'section', name: '형강', china: 'cn:section', mix: 'eaf', vote: 'hb', ref: 'kr:section', items: ['section'] }
];
// 고로재(bf)는 철광석·원료탄·코크스, 전기로재(eaf)는 고철 비중이 크다
const COST = {
  ore: { keys: ['world:iron_ore', 'krimp:iron_ore'], name: '철광석', w: { bf: 1, eaf: 0.3 } },
  coal: { keys: ['cn:coking_coal', 'world:coal', 'krimp:coking_coal'], name: '원료탄', w: { bf: 1, eaf: 0.3 } },
  coke: { keys: ['cn:coke', 'eu:coke'], name: '코크스', w: { bf: 0.8, eaf: 0.2 } },
  scrap: { keys: ['us:scrap', 'krimp:scrap', 'eu:scrap'], name: '고철', w: { bf: 0.4, eaf: 1.5 } }
};
const WEIGHT = { cost: 0.25, china: 0.25, mills: 0.2, issues: 0.15, votes: 0.15 };
const CONFW = { '높음': 1, '중간': 0.6, '낮음': 0.3 };
const MILL_REGION_W = { jp: 1, kr: 1, cn: 1, in: 0.6, us: 0.5, eu: 0.5, mx: 0.4, world: 0.5 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const arrow = p => (p > 0 ? '▲' : p < 0 ? '▼' : '') + Math.abs(r1(p)) + '%';

// 지표별 평소 1회 변동폭(%, 절댓값 평균) 사전값. 근거: 발표 주기와 자료 성격(월평균 국제가·통관 단가는 크고, 물가지수·열흘 유통가는 작다)
const PRIOR = [
  [/^world:iron_ore$/, 5], [/^world:coal$/, 7], [/^krimp:/, 4], [/^(us|eu):scrap$/, 5], [/^eu:/, 5],
  [/^cn:(coking_coal|coke)$/, 2.5], [/^cn:/, 1.5], [/^kr:/, 1], [/^us:/, 1.5]
];
const PRIOR_K = 6; // 사전값을 실제 관측 6개만큼 믿는다
function priorVol(key) { for (const [re, v] of PRIOR) if (re.test(key)) return v; return 2; }
function volOf(key, span, hist) {
  const prior = priorVol(key) * Math.sqrt(span);
  const pts = hist && hist[key] && hist[key].pts, ch = [];
  if (pts) for (let i = span; i < pts.length; i++) { const a = Number(pts[i - span][1]), b = Number(pts[i][1]); if (a) ch.push(Math.abs((b - a) / a * 100)); }
  const n = ch.length, emp = n ? ch.reduce((x, y) => x + y, 0) / n : 0;
  return { vol: Math.max(0.2, (n * emp + PRIOR_K * prior) / (n + PRIOR_K)), n };
}
// 최근 흐름: 자체 시계열이 3개 이상이면 3개 전 대비(2구간 변화), 아니면 직전 대비
function trend(key, rows, hist) {
  const pts = hist && hist[key] && hist[key].pts;
  let t = null;
  if (pts && pts.length >= 3) { const a = Number(pts[pts.length - 3][1]), b = Number(pts[pts.length - 1][1]); if (a) t = { pct: (b - a) / a * 100, span: 3 }; }
  if (!t) { const r = rows.find(x => x.key === key && !x.low); if (r && r.pct != null) t = { pct: r.pct, span: 1 }; }
  if (!t) return null;
  const v = volOf(key, t.span === 3 ? 2 : 1, hist);
  t.vol = v.vol; t.volN = v.n; t.z = t.pct / v.vol;
  return t;
}
function firstTrend(keys, rows, hist) { for (const k of keys) { const t = trend(k, rows, hist); if (t) return Object.assign({ key: k }, t); } return null; }
const times = z => { const a = Math.abs(z); return a < 0.5 ? '평소보다 작음' : '평소의 ' + (Math.round(a * 10) / 10) + '배'; };
function levelOf(score, n) {
  if (!n) return { level: null, lean: null };
  if (score >= 1) return { level: '강한 상승', lean: 'up' };
  if (score >= 0.35) return { level: '상승 우위', lean: 'up' };
  if (score <= -1) return { level: '강한 하락', lean: 'down' };
  if (score <= -0.35) return { level: '하락 우위', lean: 'down' };
  return { level: '보합', lean: score >= 0.15 ? 'up' : (score <= -0.15 ? 'down' : null) };
}
const daysBetween = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;

function compute(input) {
  const rows = input.rows || [], hist = input.hist || {}, report = input.report || null, votes = input.votes || null, today = input.today;
  return PRODUCTS.map(p => {
    const comps = [];
    // 1. 원가 압력
    let cw = 0, cs = 0; const parts = [];
    Object.keys(COST).forEach(k => { const c = COST[k], t = firstTrend(c.keys, rows, hist); if (!t) return; const w = c.w[p.mix]; cw += w; cs += w * clamp(t.z, -2, 2); parts.push(c.name + ' ' + arrow(t.pct) + '(' + times(t.z) + ')'); });
    if (cw) comps.push({ id: 'cost', name: '원가 압력', score: r2(cs / cw), text: parts.join(', ') + (p.mix === 'eaf' ? ' · 전기로재라 고철 비중 큼' : ' · 고로재라 철광석·원료탄 비중 큼') });
    // 2. 중국 가격
    const ct = trend(p.china, rows, hist);
    if (ct) comps.push({ id: 'china', name: '중국 가격', score: r2(clamp(ct.z, -2, 2)), text: '중국 ' + ({ 'cn:hr': '열연', 'cn:plate': '중후판', 'cn:rebar': '철근', 'cn:section': '앵글' }[p.china] || '') + (p.china === 'cn:hr' && p.id !== 'hr' ? '(대용)' : '') + ' ' + arrow(ct.pct) + (ct.span > 1 ? ' (최근 3회)' : ' (직전 대비)') + ' · ' + times(ct.z) });
    // 3. 제철소 가격 발표 (최근 60일)
    const mills = ((report && report.mills) || []).filter(m => m.items.some(k => p.items.includes(k)) && (!m.date || !today || daysBetween(m.date, today) <= 60));
    if (mills.length) {
      let mw = 0, ms = 0;
      mills.forEach(m => { const w = MILL_REGION_W[m.region] || 0.5; mw += w; ms += w * ({ '인상': 2, '동결': 0, '인하': -2 }[m.action] || 0); });
      comps.push({ id: 'mills', name: '제철소 가격 발표', score: r2(ms / mw), text: mills.slice(0, 3).map(m => m.maker + ' ' + m.action + (m.effective ? '(' + m.effective + ')' : '')).join(', ') + (mills.length > 3 ? ' 외 ' + (mills.length - 3) + '건' : '') });
    }
    // 4. 세계 이슈
    const iss = ((report && report.issues) || []).filter(x => (x.items || []).some(k => p.items.includes(k)) && (x.dir === '상승' || x.dir === '하락'));
    if (iss.length) {
      const sc = iss.reduce((a, x) => a + (x.dir === '상승' ? 1 : -1) * (CONFW[x.conf] || 0.3), 0);
      comps.push({ id: 'issues', name: '세계 이슈', score: r2(clamp(sc, -2, 2)), text: iss.slice(0, 2).map(x => x.title + '(' + x.dir + ')').join(', ') + (iss.length > 2 ? ' 외 ' + (iss.length - 2) + '건' : '') });
    }
    // 5. 현장 체감
    const v = p.vote && votes && votes.items && votes.items[p.vote];
    if (v && v.n >= (votes.minN || 5)) comps.push({ id: 'votes', name: '현장 체감', score: r2((v.up - v.down) / v.n * 2), text: '오름 ' + Math.round(v.up / v.n * 100) + '% · 내림 ' + Math.round(v.down / v.n * 100) + '% (' + v.n + '명)' });

    const tw = comps.reduce((a, c) => a + WEIGHT[c.id], 0);
    const score = tw ? comps.reduce((a, c) => a + WEIGHT[c.id] * c.score, 0) / tw : 0;
    const dir = !comps.length ? null : (score >= 0.35 ? '상승' : (score <= -0.35 ? '하락' : '보합'));
    const agree = comps.length ? comps.filter(c => (dir === '상승' ? c.score > 0 : dir === '하락' ? c.score < 0 : Math.abs(c.score) < 0.5)).length / comps.length : 0;
    const conf = !comps.length ? null : (comps.length >= 4 && agree >= 0.75 ? '높음' : (comps.length >= 3 && agree >= 0.5 ? '중간' : '낮음'));
    comps.forEach(c => { c.weight = Math.round(WEIGHT[c.id] / (tw || 1) * 100); });
    const lv = levelOf(score, comps.length);
    return { id: p.id, name: p.name, dir, level: lv.level, lean: lv.lean, conf, score: r2(score), agree: Math.round(agree * 100), comps, ref: p.ref };
  });
}

// 신호 기록: 품목별로 7일에 한 번만(매일 기록하면 같은 신호가 겹쳐 적중률이 부풀려진다)
function logSignals(log, sigs, hist, today) {
  const out = (log || []).slice();
  sigs.forEach(s => {
    if (!s.dir) return;
    const last = out.filter(e => e.id === s.id).pop();
    if (last && daysBetween(last.d, today) < 7) return;
    const pts = hist && hist[s.ref] && hist[s.ref].pts;
    const base = pts && pts.length ? pts[pts.length - 1] : null;
    out.push({ d: today, id: s.id, dir: s.dir, score: s.score, conf: s.conf, refKey: s.ref, basePeriod: base ? base[0] : null, baseValue: base ? Number(base[1]) : null });
  });
  return out.slice(-600);
}

// 채점: 기준 시점에서 2개월 이상 지난 국내 생산자물가(월)로 방향 비교. ±0.5% 안이면 보합
function addMonths(ym, n) { const [y, m] = String(ym).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
function grade(log, hist) {
  const per = {}, recent = [];
  let graded = 0, hits = 0;
  (log || []).forEach(e => {
    if (!e.basePeriod || !/^\d{4}-\d{2}$/.test(e.basePeriod) || !e.baseValue) return;
    const pts = hist && hist[e.refKey] && hist[e.refKey].pts; if (!pts) return;
    const target = addMonths(e.basePeriod, 2), hit = pts.find(p => p[0] >= target);
    if (!hit) return;
    const pct = (Number(hit[1]) - e.baseValue) / e.baseValue * 100, actual = pct > 0.5 ? '상승' : (pct < -0.5 ? '하락' : '보합');
    const ok = actual === e.dir;
    graded++; if (ok) hits++;
    per[e.id] = per[e.id] || { graded: 0, hits: 0 }; per[e.id].graded++; if (ok) per[e.id].hits++;
    recent.push({ d: e.d, id: e.id, dir: e.dir, actual, pct: r1(pct), ok });
  });
  return { graded, hits, rate: graded ? Math.round(hits / graded * 100) : null, per, recent: recent.slice(-12).reverse() };
}

module.exports = { compute, logSignals, grade, levelOf, volOf, PRODUCTS, WEIGHT };
