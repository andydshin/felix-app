'use strict';
// AI 초안(Anthropic Messages API). 키는 서버 환경변수 ANTHROPIC_API_KEY에서만 읽는다.
// 모델은 ANTHROPIC_MODEL, 없으면 /v1/models 목록에서 가장 최신 sonnet 계열을 고른다.
// Vercel 함수 시간(60초) 안에 끝나도록 두 번으로 나눈다: ① 세계 이슈·일정  ② 요약·지역 브리핑·전망.
// AI는 받은 제목과 숫자만 쓴다. 숫자 카드·차트는 AI가 아니라 서버 계산값으로 그린다.

const BASE = process.env.ANTHROPIC_BASE || 'https://api.anthropic.com';
const VERSION = '2023-06-01';
const { LABEL, REGION } = require('./report-data');

class AiConfigError extends Error {}
class AiError extends Error { constructor(status, detail) { super('AI request failed (' + status + ')'); this.status = status; this.detail = detail || ''; } }
function key() { const k = process.env.ANTHROPIC_API_KEY; if (!k || !k.trim()) throw new AiConfigError('ANTHROPIC_API_KEY is not set'); return k.trim(); }
function redact(s) { const k = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim(); return k ? String(s).split(k).join('[redacted]') : String(s); }

const STYLE = [
  '한국어로 쓴다. 독자는 한국 철강 유통상·실수요가·구매 담당자다.',
  '문장은 짧게. 한 문장에 한 가지 내용. 전문 용어는 처음 나올 때 쉬운 말로 풀어 쓴다.',
  '주어진 제목·공고·숫자에 없는 사실(수치, 날짜, 기관 발언, 세율)은 절대 만들지 않는다. 모르면 "확인 필요"라고 쓴다.',
  '기사 문장을 그대로 옮기지 않는다. 우리 말로 요약하고 해석한다.',
  '추측은 추측이라고 표시하고, 확실성(conf)을 낮게 둔다.',
  '문체는 철강 전문지 기사체: 결론을 첫 문장에, 숫자는 문장 속에 녹이고, 종결은 "~했다/~다/~로 보인다/~라는 해석이 나온다". "추정됩니다"를 반복하지 않는다.',
  '"업계 관계자는 ~라고 말했다" 같은 실존하지 않는 인용·발언은 만들지 않는다. 해외 보도는 "○월 ○일 매체에는 ‘제목’이라는 기사가 실렸다"처럼 매체·날짜·제목만 인용한다.',
  '기사 마지막 문단은 한국 유통상·수출업체가 다음에 확인할 것(다음 발표, 가격선)으로 끝낸다.',
  '제목은 철강 전문지 1면 헤드라인처럼 뽑는다. 25자 안팎, 두 마디를 말줄임표(…)로 잇는다. 앞은 사건, 뒤는 독자에게 미치는 뜻. 대비나 긴장이 있으면 살린다("A인데 B", "A…B 벌어져"). 숫자는 하나까지. "동향·현황·분석·주간·이어져" 같은 맥 빠진 말로 끝내지 않는다. 예: "원료탄 3% 뚝…中 판재 약세 길어지나", "수입 열연 600달러 깨져…국산과 가격 차 커진다".',
  '문체는 사람 기자가 쓴 것처럼. 문단 첫 문장에 해석을 먼저 두고, 뒤 문장에서 숫자로 받친다. 숫자를 괄호 속에 줄줄이 넣지 않는다(괄호는 문단당 한 번까지). 같은 종결어미를 세 번 연이어 쓰지 않는다. "그러나·반면·문제는·관건은·다만" 같은 연결어로 흐름을 만든다.',
  '유통 현장 말을 쓴다: 매입, 재고, 오퍼(수출 제안 가격), 저가 수입재, 가격선, 판매가 인상 시도. 통계 보도자료처럼 "~로 나타났다"를 반복하지 않는다.',
  '출력은 JSON 하나만. 설명·코드블록 표시 없이.'
].join('\n');

function dataLines(rows) {
  return rows.filter(r => r.pct != null).map(r => `${r.key} | ${r.regionName} ${r.label} | ${r.value} ${r.unit} | ${r.pct > 0 ? '+' : ''}${r.pct}% | ${r.period || ''} | ${r.basis}${r.low ? ' | 물량 적음' : ''}`).join('\n');
}

function issuesPrompt(inp) {
  const news = inp.news.news.slice(0, 90).map(a => `${a.id} | ${a.date || ''} | ${a.source} | ${a.title}${a.also ? ' (비슷한 기사 ' + a.also + '건 더)' : ''}`).join('\n');
  const off = inp.news.official.map(a => `${a.id} | ${a.date} | ${a.topic === 'kr-disclosure' ? 'DART 공시' : '미국 관보'} | ${a.title}${a.abstract ? ' — ' + a.abstract : ''}`).join('\n');
  return `오늘은 ${inp.today}. 지난 1주 세계 철강 관련 뉴스 제목과 공식 공고, 그리고 우리 플랫폼의 최신 가격 데이터다.

[가격 데이터: 키 | 품목 | 값 | 전기 대비 | 기간 | 기준]
${dataLines(inp.rows)}

[뉴스 제목: 번호 | 날짜 | 매체 | 제목]
${news || '(없음)'}

[공식 공고: 번호 | 날짜 | 출처 | 제목]
${off || '(없음)'}

할 일:
1) 한국 철강 유통 시장에 영향이 큰 세계 이슈 5~7개를 고른다. 같은 사건의 여러 기사는 하나로 묶는다. 지역(중국·미국·EU·일본·인도·한국·원료)이 고르게 섞이면 좋다. 단순 기업 홍보·주가 기사는 뺀다.
2) 각 이슈를 아래 형식으로 쓴다.
3) 공고·뉴스에서 날짜가 확인되는 앞으로 2주 안의 일정(판정 발표, 관세 발효, 회의 등)이 있으면 calendar에 넣는다. 날짜가 제목에 없으면 넣지 않는다.
3-1) 제철소·고로사의 가격 발표(인상·동결·인하, 예: 일본제철·JFE·포스코·현대제철·바오산·Nucor·AM/NS)가 제목에 있으면 mills에 따로 뽑는다. 폭·적용 시점은 제목에 있을 때만 쓰고, 없으면 빈 문자열.

JSON 형식:
{"issues":[{"type":"무역정책|공급|수요|원료|비철|거시 중 하나","title":"30자 안팎 한 줄","what":"무슨 일인가. 1~2문장","path":"어떤 경로로 한국 시장에 오나. 1~2문장","impact":"어느 품목에, 어느 방향으로, 언제쯤. 1~2문장","dir":"상승|하락|혼조|중립","items":["품목 키"],"regions":["지역 키"],"watch":"무엇을 보면 확인되나. 1문장","watchKey":"가격 데이터 키 중 하나 또는 빈 문자열","conf":"높음|중간|낮음","confWhy":"확실성 근거 1문장","sources":["n3","o1"]}],
 "calendar":[{"date":"YYYY-MM-DD","title":"짧게","why":"왜 봐야 하나 1문장","sources":["o2"]}],
 "mills":[{"maker":"회사명(한국어)","region":"지역 키","items":["품목 키"],"action":"인상|동결|인하","amount":"예: 톤당 1만엔, 없으면 빈 문자열","effective":"적용 시점, 예: 2027-01 선적, 없으면 빈 문자열","sources":["n5"]}]}
품목 키: ${Object.keys(LABEL).filter(k => k !== 'usdkrw' && k !== 'cn_supply').join(', ')}
지역 키: ${Object.keys(REGION).filter(k => k !== 'fx').join(', ')}
sources에는 위 번호만 쓴다. 이슈마다 최소 1개.`;
}

function summaryPrompt(inp, issues) {
  const a = inp.analysis;
  const mv = r => `${r.key} ${r.regionName} ${r.label} ${r.pct > 0 ? '+' : ''}${r.pct}% (${r.period})`;
  return `오늘은 ${inp.today}. 이번 주 철강 리포트의 요약부를 쓴다.

[많이 오른 것] ${a.movers.up.map(mv).join(' / ') || '없음'}
[많이 내린 것] ${a.movers.down.map(mv).join(' / ') || '없음'}
[원료] ${a.flow.raw.map(mv).join(' / ') || '없음'}
[제품] ${a.flow.product.map(mv).join(' / ') || '없음'}
[원/달러] ${a.fx ? a.fx.value + '원 (' + (a.fx.pct > 0 ? '+' : '') + a.fx.pct + '%)' : '없음'}
[중국산 철강재 수입량] ${inp.analysis.cnSupply ? inp.analysis.cnSupply.value + 't (' + inp.analysis.cnSupply.pct + '%, ' + inp.analysis.cnSupply.period + ')' : '없음'}

[지역별 숫자]
${a.regions.map(g => g.regionName + ': ' + g.rows.map(r => `${r.label} ${r.value}${r.unit} ${r.pct > 0 ? '+' : ''}${r.pct}% (${r.period}, ${r.basis})`).join(' / ')).join('\n')}

[이번 주 세계 이슈]
${issues.map(i => `- [${i.type}] ${i.title} → ${i.dir}`).join('\n') || '(없음)'}

[전망 점검에 쓸 수 있는 키] ${inp.rows.filter(r => r.pct != null && !r.low && r.kind !== 'volume').map(r => r.key).join(', ')}

JSON 형식:
{"title":"헤드라인. 25자 안팎, 위 제목 규칙대로","oneLiner":"이번 주 한 줄. 2문장 이내","article":{"lede":"리드 문단. 핵심 숫자 2~3개를 담은 2~3문장","body":["본문 문단 3~5개. 각 2~4문장. 시장 흐름 → 원인(이슈·정책) → 한국 시장 영향 → 다음 확인 포인트 순서"]},"takeaways":["핵심 3가지. 각 1문장, 숫자 근거 포함"],
 "regions":[{"region":"cn|kr|us|eu|jp|in|mx|world","text":"2~3문장. 그 지역 숫자와 이슈를 연결"}],
 "checks":[{"key":"위 키 중 하나","expect":"up|down","label":"다음 발표에서 이렇게 될 것이다. 1문장"}]}
regions는 숫자가 있는 지역만. checks는 2~3개, 다음 1~2주 안에 새 값이 나오는 항목 위주.`;
}

// 한 번에 붙여 넣는 요청문(대표님의 Claude 채팅용): 이슈·일정 + 요약·지역·전망을 JSON 하나로
function fullPrompt(inp) {
  const sum = summaryPrompt(inp, []);
  const dataPart = sum.slice(sum.indexOf('[많이 오른 것]'), sum.indexOf('[이번 주 세계 이슈]'));
  const keysPart = sum.slice(sum.indexOf('[전망 점검에 쓸 수 있는 키]'), sum.indexOf('JSON 형식:'));
  const iss = issuesPrompt(inp);
  return `너는 한국 철강 유통 시세 플랫폼 Felix의 주간 리포트 편집자다.
${STYLE}

` + iss.slice(0, iss.indexOf('JSON 형식:')) + `
4) 요약부도 함께 쓴다. 아래 숫자를 근거로 쓴다.
${dataPart}
${keysPart}
JSON 형식(이 형식 하나만 출력):
{"title":"헤드라인. 25자 안팎, 위 제목 규칙대로","oneLiner":"이번 주 한 줄. 2문장 이내","article":{"lede":"리드 문단 2~3문장, 핵심 숫자 포함","body":["본문 문단 3~5개, 각 2~4문장: 시장 흐름 → 원인 → 한국 시장 영향 → 다음 확인 포인트"]},"takeaways":["핵심 3가지, 각 1문장, 숫자 근거"],
 "regions":[{"region":"cn|kr|us|eu|jp|in|mx|world","text":"2~3문장"}],
 "issues":[{"type":"무역정책|공급|수요|원료|비철|거시","title":"","what":"","path":"","impact":"","dir":"상승|하락|혼조|중립","items":["품목 키"],"regions":["지역 키"],"watch":"","watchKey":"","conf":"높음|중간|낮음","confWhy":"","sources":["n3"]}],
 "calendar":[{"date":"YYYY-MM-DD","title":"","why":"","sources":["o2"]}],
 "checks":[{"key":"위 키 중 하나","expect":"up|down","label":"다음 발표 전망 1문장"}],
 "mills":[{"maker":"회사명(한국어)","region":"지역 키","items":["품목 키"],"action":"인상|동결|인하","amount":"예: 톤당 1만엔, 없으면 빈 문자열","effective":"적용 시점, 예: 2027-01 선적, 없으면 빈 문자열","sources":["n5"]}]}
` + iss.slice(iss.indexOf('품목 키:'));
}

function parseJson(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new AiError('no-json', s.slice(0, 200));
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { throw new AiError('bad-json', s.slice(a, a + 200)); }
}

const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 400);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

// AI 결과 검증·정리: 모르는 번호·키는 버리고, 출처는 실제 링크로 바꾼다.
// 제철소 가격 발표
function cleanMills(list, src) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map(m => ({ maker: str(m.maker, 40), region: REGION[m.region] ? m.region : '', items: (Array.isArray(m.items) ? m.items : []).filter(k => LABEL[k]).slice(0, 6),
    action: oneOf(str(m.action, 4), ['인상', '동결', '인하'], ''), amount: str(m.amount, 60), effective: str(m.effective, 40), sources: src(m.sources) })).filter(m => m.maker && m.action && m.items.length && m.sources.length);
}

function cleanIssues(j, inp) {
  const byId = {};
  inp.news.news.concat(inp.news.official).forEach(a => { byId[a.id] = a; });
  const keys = new Set(inp.rows.map(r => r.key));
  const src = ids => (Array.isArray(ids) ? ids : []).map(id => byId[id]).filter(Boolean).slice(0, 4).map(a => ({ title: a.title, url: a.url, source: a.source, date: a.date, kind: a.kind }));
  const issues = (Array.isArray(j.issues) ? j.issues : []).slice(0, 8).map((x, i) => ({
    id: 'i' + (i + 1), type: oneOf(str(x.type, 10), ['무역정책', '공급', '수요', '원료', '비철', '거시'], '거시'), title: str(x.title, 80),
    what: str(x.what), path: str(x.path), impact: str(x.impact), dir: oneOf(str(x.dir, 4), ['상승', '하락', '혼조', '중립'], '중립'),
    items: (Array.isArray(x.items) ? x.items : []).filter(k => LABEL[k]).slice(0, 4), regions: (Array.isArray(x.regions) ? x.regions : []).filter(k => REGION[k]).slice(0, 4),
    watch: str(x.watch), watchKey: keys.has(x.watchKey) ? x.watchKey : '', conf: oneOf(str(x.conf, 4), ['높음', '중간', '낮음'], '낮음'), confWhy: str(x.confWhy, 200), sources: src(x.sources)
  })).filter(x => x.title && x.sources.length);
  const calendar = (Array.isArray(j.calendar) ? j.calendar : []).filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.date)).slice(0, 8).map(c => ({ date: c.date, title: str(c.title, 80), why: str(c.why, 200), sources: src(c.sources), kind: 'event' })).filter(c => c.title);
  const mills = cleanMills(j.mills, src);
  return { issues, calendar, mills };
}

function cleanSummary(j, inp) {
  const keys = new Set(inp.rows.filter(r => r.pct != null && !r.low).map(r => r.key));
  const hasRegion = new Set(inp.analysis.regions.map(g => g.region));
  return {
    title: str(j.title, 80), oneLiner: str(j.oneLiner, 300), article: j.article && j.article.lede ? { lede: str(j.article.lede, 600), body: (Array.isArray(j.article.body) ? j.article.body : []).slice(0, 6).map(t => str(t, 900)).filter(Boolean) } : null, takeaways: (Array.isArray(j.takeaways) ? j.takeaways : []).slice(0, 3).map(t => str(t, 200)).filter(Boolean),
    regions: (Array.isArray(j.regions) ? j.regions : []).filter(r => hasRegion.has(r.region)).map(r => ({ region: r.region, text: str(r.text, 400) })),
    checks: (Array.isArray(j.checks) ? j.checks : []).filter(c => keys.has(c.key) && ['up', 'down'].includes(c.expect)).slice(0, 3).map(c => ({ key: c.key, expect: c.expect, label: str(c.label, 200) }))
  };
}

function createAi(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  let model = null;

  async function api(path, body) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl && setTimeout(() => ctl.abort(), 55000);
    try {
      const res = await fetchImpl(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'x-api-key': key(), 'anthropic-version': VERSION, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctl ? ctl.signal : undefined });
      const text = await res.text();
      if (!res.ok) throw new AiError(res.status, redact(text.slice(0, 300)));
      return JSON.parse(text);
    } catch (e) { if (e instanceof AiError) throw e; throw new AiError(e.name === 'AbortError' ? 'timeout' : 'network', redact(e.message)); }
    finally { if (t) clearTimeout(t); }
  }

  async function pickModel() {
    if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL.trim();
    if (model) return model;
    const j = await api('/v1/models?limit=100');
    const ids = (j.data || []).map(m => m.id);
    model = ids.find(id => /sonnet/i.test(id)) || ids[0];
    if (!model) throw new AiError('no-model');
    return model;
  }

  async function ask(prompt, maxTokens) {
    const m = await pickModel();
    const j = await api('/v1/messages', { model: m, max_tokens: maxTokens, system: STYLE, messages: [{ role: 'user', content: prompt }] });
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return { json: parseJson(text), model: m, usage: j.usage || null };
  }

  return {
    pickModel,
    async issues(inp) { const r = await ask(issuesPrompt(inp), 4000); return Object.assign(cleanIssues(r.json, inp), { model: r.model, usage: r.usage }); },
    async summary(inp, issues) { const r = await ask(summaryPrompt(inp, issues), 2500); return Object.assign(cleanSummary(r.json, inp), { model: r.model, usage: r.usage }); }
  };
}

module.exports = { cleanMills, fullPrompt, createAi, AiConfigError, AiError, cleanIssues, cleanSummary, parseJson, issuesPrompt, summaryPrompt };
