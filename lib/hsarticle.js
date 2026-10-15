'use strict';
// HS 검색 결과를 철강 전문지 기사체로 쓴다(규칙 기반, AI 없음).
// 원칙: 숫자는 통계에서만, 해외 보도는 제목·매체·날짜만 인용, 실존하지 않는 '업계 관계자' 발언은 만들지 않는다.
const fmt = v => Math.round(v).toLocaleString('en-US');
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
function monthKo(ym, now) { const y = Number(String(ym).slice(0, 4)), m = Number(String(ym).replace('-', '').slice(4, 6)); return (y === now.getUTCFullYear() ? '' : (y === now.getUTCFullYear() - 1 ? '지난해 ' : y + '년 ')) + m + '월'; }
function nextYm(ym) { const y = Number(String(ym).slice(0, 4)), m = Number(String(ym).replace('-', '').slice(4, 6)); const d = new Date(Date.UTC(y, m, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
const josa = (w, a, b) => { const c = String(w).replace(/[^가-힣0-9]+$/, '').slice(-1); const code = c.charCodeAt(0); const has = /[0-9]/.test(c) ? /[013678]/.test(c) : (code >= 0xAC00 && code <= 0xD7A3 && (code - 0xAC00) % 28 !== 0); return w + (has ? a : b); };

function compose(out, opts) {
  const M = out.main; if (!M || M.months.length < 2) return null;
  const now = (opts && opts.now) || new Date();
  const item = (out.preset && out.preset.name) || out.topicName || '철강재', mkt = out.marketName;
  const ps = out.partners.map(p => p.code).filter(p => M.series[p] && p !== 'WD');
  const W = M.series.WD, n = M.months.length;
  const st = {};
  ps.forEach(p => {
    const t = M.series[p].total, T = sum(t, x => x.t), U = sum(t, x => x.usd);
    let li = -1; for (let k = t.length - 1; k >= 0; k--) if (t[k].t > 0) { li = k; break; }
    const prior = t.slice(Math.max(0, li - 3), li).filter(x => x.t > 0);
    const pAvg = prior.length ? sum(prior, x => x.t) / prior.length : null;
    const l3 = sum(t.slice(-3), x => x.t), p3 = sum(t.slice(-6, -3), x => x.t);
    st[p] = { name: M.series[p].name + '산', T, unit: T ? U / T : null, share: W ? T / sum(W.total, x => x.t) * 100 : null, last: li >= 0 ? t[li] : null, pAvg, dv: p3 ? (l3 - p3) / p3 * 100 : null };
  });
  const act = ps.filter(p => st[p].T > 0).sort((a, b) => st[b].T - st[a].T);
  if (!act.length) return null;
  const top = act[0], sec = act[1];
  const priced = act.filter(p => st[p].unit), byPrice = priced.slice().sort((a, b) => st[a].unit - st[b].unit);
  const lo = byPrice[0], hi = byPrice[byPrice.length - 1], gp = lo && hi && lo !== hi ? (st[hi].unit - st[lo].unit) / st[lo].unit * 100 : 0;
  const hiHolds = hi && (st[hi].dv == null || st[hi].dv > -10);
  // 관세 인상 전후(멕시코)
  let policy = null;
  if (out.market === 'MX') {
    const pre = M.months.filter(m => m >= '2025-10' && m <= '2025-12'), post = M.months.filter(m => m >= '2026-01').slice(0, 6);
    if (pre.length >= 2 && post.length >= 3) {
      const avg = (p, ms) => { const s = M.series[p].total.filter(x => ms.includes(x.ym.slice(0, 4) + '-' + x.ym.slice(4))); return s.length ? sum(s, x => x.t) / s.length : 0; };
      const rows = act.map(p => { const a = avg(p, pre), b = avg(p, post); return { p, a, b, d: a ? (b - a) / a * 100 : null }; }).filter(r => r.d != null);
      if (rows.length) policy = { postN: post.length, rows, div: rows.length >= 2 && Math.max(...rows.map(r => r.d)) - Math.min(...rows.map(r => r.d)) > 20 };
    }
  }
  const T = st[top], lastJump = T.last && T.pAvg ? (T.last.t - T.pAvg) / T.pAvg * 100 : null;

  // 제목
  let headline;
  if (policy && policy.div) { const up = policy.rows.slice().sort((a, b) => b.d - a.d)[0], dn = policy.rows.slice().sort((a, b) => a.d - b.d)[0]; headline = '관세 올렸는데… ' + mkt + ' ' + item + ' 수입, ' + st[up.p].name + ' ' + (up.d > 0 ? '늘고' : '덜 줄고') + ' ' + st[dn.p].name + ' 줄었다'; }
  else if (lastJump != null && Math.abs(lastJump) >= 50) headline = mkt + ' ' + item + ' 시장, ' + T.name + ' 물량 ' + (lastJump > 0 ? '급증' : '급감') + '… ' + monthKo(T.last.ym, now) + ' ' + fmt(T.last.t) + '톤';
  else if (gp >= 10 && hiHolds) headline = st[lo].name + ' 저가재 vs ' + st[hi].name + ' 고급재… ' + mkt + ' ' + item + ' 시장 양분';
  else headline = mkt + ' ' + item + ' 수입, ' + T.name + '이 ' + Math.round(T.share || 0) + '% 차지';

  // 리드
  const other = act.find(p => p !== top && st[p].last && st[p].last.unit);
  let lede = mkt + '의 ' + T.name + ' ' + item + ' 수입이 ' + monthKo(T.last.ym, now) + ' ' + fmt(T.last.t) + '톤을 기록했다';
  if (lastJump != null) lede += Math.abs(lastJump) < 5 ? '. 직전 3개월 평균과 비슷한 수준이다.' : '. 직전 3개월 평균보다 ' + Math.abs(Math.round(lastJump)) + '% ' + (lastJump > 0 ? '많다.' : '적다.');
  else lede += '.';
  if (T.last.unit && other) { const ou = st[other].last.unit, g = T.last.unit - ou; lede += ' 톤당 수입가(CIF)는 ' + fmt(T.last.unit) + '달러로 ' + st[other].name + '(' + fmt(ou) + '달러)보다 ' + fmt(Math.abs(g)) + '달러 ' + (g < 0 ? '낮다.' : '높다.'); }

  const body = [];
  // 시장 구조
  if (W) body.push('최근 ' + n + '개월 누적으로 보면 ' + mkt + '는 이 품목을 ' + fmt(sum(W.total, x => x.t)) + '톤 들여왔고, 이 가운데 ' + T.name + '이 ' + Math.round(T.share) + '%' + (sec ? ', ' + st[sec].name + '이 ' + Math.round(st[sec].share) + '%' : '') + '를 차지했다. ' + (T.share >= 40 ? T.name + '이 사실상 시장 가격의 기준 역할을 하는 구조다.' : '어느 한 나라가 시장을 쥐고 있는 구조는 아니다.'));
  // 가격·품질
  if (gp >= 10) body.push(st[hi].name + '은 ' + st[lo].name + '보다 평균 ' + Math.round(gp) + '% 비싸다. ' + (hiHolds ? '그럼에도 물량은 큰 흔들림 없이 유지되고 있어, 가격보다 품질과 장기 공급 관계로 거래되는 수요가 받쳐 주는 것으로 풀이된다.' : '최근 들어 물량이 줄고 있어 가격 차이 부담이 나타나기 시작했다는 해석이 가능하다.'));
  else if (lo && hi && lo !== hi) body.push(st[lo].name + '과 ' + st[hi].name + '의 평균 단가 차이는 ' + Math.round(gp) + '%에 그친다. 비슷한 등급끼리 가격으로 맞붙는 구도다.');
  // 정책
  if (policy) {
    const list = policy.rows.map((r, i) => st[r.p].name + '은 월평균 ' + fmt(r.a) + '톤에서 ' + fmt(r.b) + '톤으로 ' + Math.abs(Math.round(r.d)) + '% ' + (r.d >= 0 ? (i < policy.rows.length - 1 ? '늘었고' : '늘었다') : (i < policy.rows.length - 1 ? '줄었고' : '줄었다'))).join(', ');
    body.push(mkt + '는 올해 1월부터 FTA를 맺지 않은 나라의 철강 제품에 관세를 올렸다. 시행 전 석 달과 이후 ' + policy.postN + '개월을 비교하면 ' + list + '. ' + (policy.div ? '같은 관세를 적용받는데도 흐름이 엇갈린 것은 가격 경쟁력이나 수출용 가공 제도(IMMEX) 같은 감면 경로를 쓰는 수입업체 비중의 차이가 더 크게 작용했기 때문으로 보인다.' : (policy.rows.every(r => r.d > -15) ? '관세 인상의 효과가 아직 수입량에 뚜렷하게 나타나지 않고 있다는 뜻이다.' : '관세 인상이 실제 수입 감소로 이어지는 모습이다.')));
  }
  // 한국 통계
  if (out.koreaExport && out.koreaExport.series.KR) {
    const k = out.koreaExport.series.KR.total; let ki = -1; for (let j = k.length - 1; j >= 0; j--) if (k[j].t > 0) { ki = j; break; }
    if (ki >= 0) { const kc = k[ki], lag = M.months.length ? (Number(kc.ym.slice(0, 4)) * 12 + Number(kc.ym.slice(4))) - (Number(M.months[n - 1].slice(0, 4)) * 12 + Number(M.months[n - 1].slice(5))) : 0;
      body.push('한국 관세청 통계로는 ' + monthKo(kc.ym, now) + ' 대' + mkt + ' 수출이 ' + fmt(kc.t) + '톤(톤당 ' + fmt(kc.unit || 0) + '달러, FOB)으로 집계됐다.' + (lag > 0 ? ' ' + mkt + ' 통계보다 ' + lag + '개월 앞선 자료여서, 한국산 흐름을 먼저 가늠해 볼 수 있다.' : '')); }
  }
  // 해외 보도
  const news = (out.news || []).slice(0, 2);
  const dKo = d => d ? Number(d.slice(5, 7)) + '월 ' + Number(d.slice(8, 10)) + '일 ' : '';
  if (news.length) body.push('해외 보도에서도 관련 움직임이 이어지고 있다. ' + news.map(a => dKo(a.date) + (a.source || '외신') + '에는 \u2018' + a.title + '\u2019라는 기사가 실렸다').join('. ') + '.');
  // 마무리
  const nx = monthKo(nextYm(M.months[n - 1]), now);
  body.push('다음 확인 지점은 ' + mkt + '의 ' + nx + '분 통계다. ' + (lo && hi && lo !== hi ? st[lo].name + ' 단가가 ' + fmt(Math.floor(st[lo].unit / 50) * 50) + '달러 아래로 내려오는지, ' + josa(st[hi].name, '이', '가') + ' 물량을 지키는지가 관전 포인트다.' : T.name + ' 물량이 지금 수준을 이어 가는지가 관전 포인트다.'));
  return { headline, lede, body, byline: 'Felix 데이터룸 · ' + now.toISOString().slice(0, 10), basis: '수입국·한국 무역 통계와 해외 보도를 바탕으로 작성했습니다. 해석은 통계 흐름에 근거한 판단입니다.' };
}

module.exports = { compose, monthKo };
