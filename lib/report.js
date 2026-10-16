'use strict';
// 주간 리포트: 수집 → AI 초안(2단계) → 대표 검수·수정 → 발행.
//  GET  /api/report[?no=N]   공개. 발행된 최신호(또는 N호)와 목록
//  POST /api/report-admin    관리자. 헤더 x-admin-token = 환경변수 FELIX_ADMIN_TOKEN
//       body.action: collect | draft-issues | draft-summary | get | save | publish
//  GET  /api/report-cron     Vercel Cron. 헤더 Authorization: Bearer <CRON_SECRET> → 자료 수집만
//  GET  /api/report-probe    관리자 토큰 필요. 뉴스 소스·저장소·AI 연결 상태
const crypto = require('crypto');
const { normalize, analyze, releaseCalendar, SOURCES, pctOf, autoSummary } = require('./report-data');
const { createNews } = require('./news');
const { createKv } = require('./kv');
const signal = require('./signal');
const { createAi, AiConfigError, AiError, fullPrompt, cleanIssues, cleanSummary, parseJson } = require('./report-ai');

const K = { inputs: 'report:inputs', draft: 'report:draft', index: 'report:index', issue: n => 'report:issue:' + n };

function sameSecret(given, want) {
  given = String(given == null ? '' : given).trim(); want = String(want == null ? '' : want).trim();
  if (!want || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest(), b = crypto.createHash('sha256').update(String(want)).digest();
  return crypto.timingSafeEqual(a, b);
}
function kstToday(d) { return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
function weekLabel(ymd) { const [y, m, d] = ymd.split('-').map(Number); return y + '년 ' + m + '월 ' + Math.ceil(d / 7) + '주'; }

// 지난호 전망 채점: 발행 때 저장한 기준값과 지금 값을 비교. 새 기간 값이 아직 없으면 '대기'.
function gradeChecks(checks, rows) {
  return (checks || []).map(c => {
    const r = rows.find(x => x.key === c.key);
    if (!r || r.value == null) return Object.assign({}, c, { result: 'nodata' });
    if (r.period === c.basePeriod) return Object.assign({}, c, { result: 'pending', nowPeriod: r.period });
    const pct = pctOf(r.value, c.baseValue);
    const hit = pct == null ? null : (c.expect === 'up' ? pct > 0 : pct < 0);
    return Object.assign({}, c, { result: hit == null ? 'nodata' : (hit ? 'hit' : 'miss'), nowValue: r.value, nowPeriod: r.period, pct });
  });
}

function createReport(opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || globalThis.fetch;
  const now = o.now || (() => new Date());
  const kv = o.kv || createKv({ fetch: fetchImpl });
  const news = o.news || createNews({ fetch: fetchImpl, now });
  const ai = o.ai || createAi({ fetch: fetchImpl });
  const history = o.history || null;
  const votes = o.votes || null;
  const hsNotes = o.hsNotes || null;
  const panel = o.panel || null;
  const archive = o.archive || null;
  let sigCache = null;

  async function fetchOwn(base) {
    const raw = {};
    await Promise.all(SOURCES.map(async s => {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ctl && setTimeout(() => ctl.abort(), 45000);
      try { const res = await fetchImpl(base + s.path, { headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined }); const j = await res.json(); raw[s.id] = res.ok ? j : { error: j.error || res.status }; }
      catch (e) { raw[s.id] = { error: e.name === 'AbortError' ? 'timeout' : 'network' }; }
      finally { if (t) clearTimeout(t); }
    }));
    return raw;
  }

  async function collect(base, preRaw) {
    const [raw, nw, index] = await Promise.all([preRaw || fetchOwn(base), news.collect(7), kv.get(K.index)]);
    const { rows, status } = normalize(raw);
    const today = kstToday(now());
    let snap = null;
    if (history) { try { snap = await history.snapshot(rows); } catch (e) { snap = { error: String(e.status || e.message) }; } }
    let pastCheck = null;
    const last = index && index[0] ? await kv.get(K.issue(index[0].no)) : null;
    if (last && last.checks && last.checks.length) pastCheck = { no: last.no, weekLabel: last.weekLabel, checks: gradeChecks(last.checks, rows) };
    const inputs = { today, rows, status, analysis: analyze(rows), news: nw, releases: releaseCalendar(new Date(today + 'T00:00:00Z')), pastCheck, collectedAt: new Date().toISOString() };
    await kv.set(K.inputs, inputs);
    return { today, rows: rows.length, status, history: snap, news: nw.news.length, official: nw.official.length, newsErrors: nw.errors, pastCheck: !!pastCheck, _news: nw };
  }

  // 매일: 숫자만 저장(자체 시계열). 수요일(KST)에는 리포트 자료 수집까지.
  async function daily(base) {
    const kstDay = new Date(now().getTime() + 9 * 3600000).getUTCDay();
    const raw = await fetchOwn(base);
    const { rows, status } = normalize(raw);
    let out, nw = null;
    if (kstDay === 3) { out = Object.assign({ mode: 'collect' }, await collect(base, raw)); nw = out._news; delete out._news; }
    else out = { mode: 'snapshot', rows: rows.length, status, history: history ? await history.snapshot(rows) : null };
    let sig = null;
    try { const r2 = await logSignalsNow(base, raw); out.signals = r2.out; sig = r2.products; } catch (e) { out.signals = { error: String(e.status || e.message) }; }
    // 일별 원자료 보관(덮어쓰기 없음)
    if (archive) {
      try {
        out.archive = await archive.save({
          raw, rows, status,
          signals: sig ? sig.map(p => ({ id: p.id, dir: p.dir, level: p.level, lean: p.lean, score: p.score, conf: p.conf, comps: (p.comps || []).map(c => ({ id: c.id, score: c.score, brief: c.brief })) })) : null,
          news: nw ? { news: (nw.news || []).map(n => ({ title: n.title, url: n.url, source: n.source, date: n.date, topic: n.topic })), official: (nw.official || []).map(n => ({ title: n.title, url: n.url, source: n.source, date: n.date })) } : null
        });
      } catch (e) { out.archive = { error: String(e.status || e.message) }; }
    }
    return out;
  }

  // 가격 방향 신호: 최신 숫자 + 자체 시계열 + 최신 발행 리포트(제철소 발표·이슈) + 체감 투표
  async function signals(base, opt) {
    if (!(opt && opt.fresh) && sigCache && sigCache.exp > Date.now()) return sigCache.v;
    const [raw, index, vr, hs, log] = await Promise.all([(opt && opt.raw) || fetchOwn(base), kv.get(K.index), votes ? votes.results().catch(() => null) : null, history ? history.get().catch(() => null) : null, kv.get('signal:log')]);
    const { rows } = normalize(raw);
    const report = index && index[0] ? await kv.get(K.issue(index[0].no)) : null;
    const hist = hs ? hs.series : {};
    const today = kstToday(now());
    const products = signal.compute({ rows, hist, report, votes: vr, today });
    const v = { status: 'ok', today, horizon: '향후 1~3개월', weights: signal.WEIGHT, products, report: report ? { no: report.no, date: report.date, mills: report.mills || [] } : null, track: signal.grade(log || [], hist), computedAt: new Date().toISOString() };
    sigCache = { v, exp: Date.now() + 30 * 60000, hist, products, today };
    return v;
  }
  async function logSignalsNow(base, raw) {
    const v = await signals(base, { fresh: true, raw });
    const log = signal.logSignals((await kv.get('signal:log')) || [], v.products, sigCache.hist, v.today);
    await kv.set('signal:log', log);
    trackCache = null;
    return { out: { logged: log.length, head: log.length ? log[log.length - 1].h.slice(0, 12) : null }, products: v.products };
  }

  // 공개 신호 기록: 모든 기록과 채점 결과, 지문 사슬. 누구나 같은 계산으로 검증할 수 있다.
  let trackCache = null;
  async function track() {
    if (trackCache && trackCache.exp > Date.now()) return trackCache.v;
    const [log, hs] = await Promise.all([kv.get('signal:log'), history ? history.get().catch(() => null) : null]);
    const L = log || [], hist = hs ? hs.series : {};
    const names = {}; signal.PRODUCTS.forEach(p => { names[p.id] = p.name; });
    const g = signal.grade(L, hist), ver = signal.verifyLog(L);
    const pend = L.map(e => signal.gradeEntry(e, hist)).filter(x => x.status === 'pending').map(x => x.due).sort();
    const entries = L.slice(-300).reverse().map(e => Object.assign({ d: e.d, id: e.id, name: names[e.id] || e.id, dir: e.dir, conf: e.conf, score: e.score, refKey: e.refKey, basePeriod: e.basePeriod, baseValue: e.baseValue, p: e.p, h: e.h }, { result: signal.gradeEntry(e, hist) }));
    const v = { status: 'ok', count: L.length, since: L[0] ? L[0].d : null, graded: g.graded, hits: g.hits, rate: g.rate, per: g.per, pending: pend.length, nextDue: pend[0] || null,
      chain: { ok: ver.ok, head: ver.head, broken: ver.broken }, entries,
      method: { rule: '기준 월 국내 생산자물가 대비 2개월 뒤 값이 +0.5% 넘으면 상승, -0.5% 밑이면 하락, 그 사이는 보합. 신호 방향과 같으면 적중.', hash: 'h = SHA-256(p + JSON([d, id, dir, score, conf, refKey, basePeriod, baseValue])), p = 직전 기록의 h(첫 기록은 genesis)' } };
    trackCache = { v, exp: Date.now() + 10 * 60000 };
    return v;
  }

  async function needInputs() { const i = await kv.get(K.inputs); if (!i) throw Object.assign(new Error('no-inputs'), { code: 'no_inputs' }); return i; }

  async function draftIssues() {
    const inp = await needInputs();
    const r = await ai.issues(inp);
    const draft = Object.assign({}, (await kv.get(K.draft)) || {}, { issues: r.issues, calendar: r.calendar, mills: r.mills || [], inputsAt: inp.collectedAt, model: r.model, updatedAt: new Date().toISOString() });
    await kv.set(K.draft, draft);
    return { issues: r.issues.length, calendar: r.calendar.length, model: r.model, usage: r.usage };
  }

  async function draftSummary() {
    const inp = await needInputs();
    const d = (await kv.get(K.draft)) || {};
    const r = await ai.summary(inp, d.issues || []);
    const draft = Object.assign({}, d, { title: r.title, oneLiner: r.oneLiner, article: r.article || d.article || null, takeaways: r.takeaways, regions: r.regions, checks: r.checks, inputsAt: inp.collectedAt, updatedAt: new Date().toISOString() });
    await kv.set(K.draft, draft);
    return { title: r.title, regions: r.regions.length, checks: r.checks.length, model: r.model, usage: r.usage };
  }

  // AI 없이: 숫자로 요약·지역 문장 채우기(이슈·일정·전망은 그대로 둔다)
  async function draftAuto() {
    const inp = await needInputs();
    const d = (await kv.get(K.draft)) || {};
    const a = autoSummary(inp.analysis);
    const draft = Object.assign({ issues: [], calendar: [], checks: [] }, d, a, { inputsAt: inp.collectedAt, model: 'auto', updatedAt: new Date().toISOString() });
    await kv.set(K.draft, draft);
    return { title: a.title, regions: a.regions.length };
  }

  // 대표님의 Claude 채팅에 붙여 넣을 요청문
  async function prompt() { return { prompt: fullPrompt(await needInputs()) }; }

  // Claude 채팅 답(JSON)을 붙여 넣기 → 검증 후 초안으로
  async function importAnswer(text) {
    const inp = await needInputs();
    let j;
    try { j = parseJson(text); } catch (e) { throw Object.assign(new Error('bad-answer'), { code: 'bad_answer' }); }
    const a = cleanIssues(j, inp), b = cleanSummary(j, inp);
    const d = (await kv.get(K.draft)) || {};
    const draft = Object.assign({}, d, { issues: a.issues, calendar: a.calendar, mills: a.mills, title: b.title || d.title, oneLiner: b.oneLiner || d.oneLiner, article: b.article || d.article || null, takeaways: b.takeaways.length ? b.takeaways : d.takeaways, regions: b.regions.length ? b.regions : d.regions, checks: b.checks, inputsAt: inp.collectedAt, model: 'claude-chat', updatedAt: new Date().toISOString() });
    await kv.set(K.draft, draft);
    return { mills: a.mills.length, issues: a.issues.length, dropped: (Array.isArray(j.issues) ? j.issues.length : 0) - a.issues.length, calendar: a.calendar.length, checks: b.checks.length, title: draft.title };
  }

  // 관리자 화면에서 고친 초안 저장(필드만 골라 받는다)
  function sanitizeDraft(d) {
    const s = (v, n) => String(v == null ? '' : v).slice(0, n || 600);
    const arr = v => (Array.isArray(v) ? v : []);
    const src = l => arr(l).filter(x => x && /^https?:\/\//i.test(x.url)).slice(0, 5).map(x => ({ title: s(x.title, 200), url: s(x.url, 500), source: s(x.source, 80), date: s(x.date, 10), kind: s(x.kind, 10) }));
    return {
      title: s(d.title, 120), oneLiner: s(d.oneLiner, 400), article: d.article && d.article.lede ? { lede: s(d.article.lede, 800), body: arr(d.article.body).slice(0, 8).map(t => s(t, 1200)).filter(Boolean) } : null, takeaways: arr(d.takeaways).slice(0, 5).map(t => s(t, 300)).filter(Boolean),
      regions: arr(d.regions).slice(0, 8).map(r => ({ region: s(r.region, 8), text: s(r.text, 600) })).filter(r => r.text),
      issues: arr(d.issues).slice(0, 10).map((x, i) => ({ id: 'i' + (i + 1), type: s(x.type, 10), title: s(x.title, 120), what: s(x.what), path: s(x.path), impact: s(x.impact), dir: s(x.dir, 4), items: arr(x.items).slice(0, 5).map(k => s(k, 20)), regions: arr(x.regions).slice(0, 5).map(k => s(k, 8)), watch: s(x.watch), watchKey: s(x.watchKey, 40), conf: s(x.conf, 4), confWhy: s(x.confWhy, 300), sources: src(x.sources) })).filter(x => x.title),
      calendar: arr(d.calendar).slice(0, 12).map(c => ({ date: s(c.date, 10), title: s(c.title, 120), why: s(c.why, 300), sources: src(c.sources), kind: 'event' })).filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.date) && c.title),
      mills: arr(d.mills).slice(0, 12).map(m => ({ maker: s(m.maker, 40), region: s(m.region, 8), items: arr(m.items).slice(0, 6).map(k => s(k, 20)), action: ['인상', '동결', '인하'].includes(m.action) ? m.action : '', amount: s(m.amount, 60), effective: s(m.effective, 40), date: s(m.date, 10), note: s(m.note, 120), sources: src(m.sources) })).filter(m => m.maker && m.action && m.items.length),
      checks: arr(d.checks).slice(0, 4).map(c => ({ key: s(c.key, 40), expect: c.expect === 'up' ? 'up' : 'down', label: s(c.label, 300) })).filter(c => c.key && c.label)
    };
  }

  async function save(d) {
    const cur = (await kv.get(K.draft)) || {};
    const draft = Object.assign({}, cur, sanitizeDraft(d || {}), { updatedAt: new Date().toISOString() });
    await kv.set(K.draft, draft);
    return draft;
  }

  async function publish(no) {
    const [inp, d, index] = await Promise.all([needInputs(), kv.get(K.draft), kv.get(K.index)]);
    if (!d || !d.title) throw Object.assign(new Error('no-draft'), { code: 'no_draft' });
    const list = index || [];
    const n = Number(no) > 0 ? Math.floor(Number(no)) : ((list[0] && list[0].no) || 0) + 1;
    const clean = sanitizeDraft(d);
    clean.mills.forEach(m => { if (!m.date) m.date = inp.today; });
    // 다음 호 채점용 기준값을 함께 저장
    const checks = clean.checks.map(c => { const r = inp.rows.find(x => x.key === c.key); return r ? Object.assign({}, c, { baseValue: r.value, basePeriod: r.period, itemLabel: r.regionName + ' ' + r.label }) : null; }).filter(Boolean);
    const cal = clean.calendar.concat(inp.releases).sort((a, b) => a.date.localeCompare(b.date));
    const slog = (await kv.get('signal:log')) || [];
    const trackHead = slog.length ? { head: slog[slog.length - 1].h || null, count: slog.length, at: slog[slog.length - 1].d } : null;
    const issue = Object.assign({ no: n, date: inp.today, weekLabel: weekLabel(inp.today), publishedAt: new Date().toISOString(), trackHead }, clean, {
      checks, calendar: cal, analysis: inp.analysis, pastCheck: inp.pastCheck, dataAt: inp.collectedAt,
      credits: ['출처: 중국 국가통계국, 한국은행(KOSIS), 관세청, 美 BLS, World Bank(CC BY 4.0), 인도 상공부 경제자문실, U.S. Census Bureau, 財務省 貿易統計(e-Stat), Eurostat, 한국수출입은행', '뉴스는 제목과 링크만 인용하며 요약·해석은 Felix가 작성했습니다. 뉴스 검색: GDELT Project. 미국 공고: Federal Register.']
    });
    await kv.set(K.issue(n), issue);
    const nextIndex = [{ no: n, weekLabel: issue.weekLabel, title: issue.title, date: issue.date }].concat(list.filter(x => x.no !== n)).sort((a, b) => b.no - a.no).slice(0, 200);
    await kv.set(K.index, nextIndex);
    return { no: n, weekLabel: issue.weekLabel };
  }

  async function publicGet(no) {
    const index = (await kv.get(K.index)) || [];
    const n = Number(no) > 0 ? Number(no) : (index[0] && index[0].no);
    const issue = n ? await kv.get(K.issue(n)) : null;
    return { status: issue ? 'ok' : 'empty', issue, list: index.slice(0, 30) };
  }

  async function adminGet() {
    const [inp, draft, index] = await Promise.all([kv.get(K.inputs), kv.get(K.draft), kv.get(K.index)]);
    return { inputs: inp ? { today: inp.today, collectedAt: inp.collectedAt, rows: inp.rows.length, status: inp.status, news: inp.news.news.length, official: inp.news.official.length, newsErrors: inp.news.errors, analysis: inp.analysis, pastCheck: inp.pastCheck, releases: inp.releases, newsList: inp.news.news.slice(0, 60).concat(inp.news.official) } : null, draft, index: index || [], nextNo: ((index && index[0] && index[0].no) || 0) + 1, kvConfigured: kv.configured() };
  }

  async function probe() {
    const out = { checkedAt: new Date().toISOString(), kv: null, ai: null, gdelt: null, fedreg: null, adminToken: !!process.env.FELIX_ADMIN_TOKEN, cronSecret: !!process.env.CRON_SECRET };
    try { out.kv = { configured: kv.configured(), ping: await kv.ping() }; } catch (e) { out.kv = { configured: kv.configured(), error: String(e.status || e.message) }; }
    try { out.ai = { model: await ai.pickModel() }; } catch (e) { out.ai = { error: e instanceof AiConfigError ? 'not_configured' : String(e.status), detail: e.detail }; }
    try { const f = await news.fedreg(14); out.fedreg = { ok: true, count: f.count, sample: f.items.slice(0, 3).map(x => x.date + ' ' + x.title) }; } catch (e) { out.fedreg = { ok: false, status: String(e.status || e.message), detail: e.detail }; }
    try { const g = await news.gnews(7); out.gnews = { ok: g.items.length > 0, count: g.items.length, errors: g.errors, sample: g.items.slice(0, 5).map(x => x.date + ' ' + x.source + ' | ' + x.title) }; } catch (e) { out.gnews = { ok: false, status: String(e.message) }; }
    try { const g = await news.gdelt(7); out.gdelt = { ok: g.items.length > 0, count: g.items.length, errors: g.errors, sample: g.items.slice(0, 5).map(x => x.date + ' ' + x.source + ' | ' + x.title) }; } catch (e) { out.gdelt = { ok: false, status: String(e.message) }; }
    return out;
  }

  return { hsNotes, panel, archive, track, signals, collect, daily, draftIssues, draftSummary, draftAuto, prompt, importAnswer, save, publish, publicGet, adminGet, probe };
}

// 라우터 연결
function baseUrl(ctx) {
  if (process.env.FELIX_BASE_URL) return process.env.FELIX_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const h = (ctx && ctx.headers) || {};
  return (h['x-forwarded-proto'] || 'http') + '://' + (h['x-forwarded-host'] || h.host || 'localhost');
}

function errOut(e, send, log) {
  if (e && e.code === 'no_inputs') return send(409, { error: 'no_inputs', message: '먼저 자료 수집을 실행하세요.' });
  if (e && e.code === 'bad_answer') return send(400, { error: 'bad_answer', message: '붙여 넣은 답에서 JSON을 찾지 못했습니다. Claude 답 전체를 복사했는지 확인하세요.' });
  if (e && e.code === 'no_draft') return send(409, { error: 'no_draft', message: '초안이 없습니다.' });
  if (e instanceof AiConfigError) return send(503, { error: 'not_configured', message: '서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다.' });
  if (e instanceof AiError) { log('report ai ' + e.status); return send(502, { error: 'ai', status: String(e.status), message: e.detail }); }
  log('report error ' + (e && (e.status || e.message)));
  send(500, { error: 'internal', message: String(e && (e.status || e.message) || '') });
}

function makeReportHandlers(svc, log) {
  const r = svc || createReport();
  const logger = log || (m => console.error(m));
  const adminOk = ctx => sameSecret(ctx && ctx.headers && ctx.headers['x-admin-token'], process.env.FELIX_ADMIN_TOKEN);
  return {
    track: async (q, send) => { try { send(200, await r.track(), 'public, max-age=600'); } catch (e) { errOut(e, send, logger); } },
    signals: async (q, send, ctx) => { try { send(200, await r.signals(baseUrl(ctx)), 'public, max-age=600'); } catch (e) { errOut(e, send, logger); } },
    public: async (q, send) => { try { const v = await r.publicGet(q.no); send(200, v, v.status === 'ok' ? 'public, max-age=120' : null); } catch (e) { errOut(e, send, logger); } },
    admin: async (q, send, ctx) => {
      if (!String(process.env.FELIX_ADMIN_TOKEN || '').trim()) return send(503, { error: 'not_configured', message: '서버에 FELIX_ADMIN_TOKEN이 없습니다. Vercel 환경변수(Production)에 넣고 Redeploy 하세요.' });
      if (!adminOk(ctx)) return send(401, { error: 'unauthorized', message: '토큰이 서버 값과 다릅니다. 입력한 토큰을 확인하세요.' });
      const b = (ctx && ctx.body) || {};
      try {
        switch (b.action) {
          case 'collect': return send(200, await r.collect(baseUrl(ctx)));
          case 'draft-issues': return send(200, await r.draftIssues());
          case 'draft-summary': return send(200, await r.draftSummary());
          case 'draft-auto': return send(200, await r.draftAuto());
          case 'prompt': return send(200, await r.prompt());
          case 'import': return send(200, await r.importAnswer(String(b.text || '').slice(0, 200000)));
          case 'get': return send(200, await r.adminGet());
          case 'save': return send(200, { ok: true, draft: await r.save(b.draft) });
          case 'publish': return send(200, await r.publish(b.no));
          case 'notes-get': return send(200, { notes: r.hsNotes ? await r.hsNotes.all() : [] });
          case 'panel-list': return send(200, r.panel ? await r.panel.list() : { count: 0, items: [] });
          case 'archive-list': return send(200, r.archive ? await r.archive.list() : { days: 0, items: [] });
          case 'archive-get': return send(200, r.archive ? await r.archive.get(b.day) : { error: 'not_configured' });
          case 'archive-verify': return send(200, r.archive ? await r.archive.verify(b.limit) : { error: 'not_configured' });
          case 'notes-save': return send(200, { notes: r.hsNotes ? await r.hsNotes.save(b.notes) : [] });
          default: return send(400, { error: 'bad_action' });
        }
      } catch (e) { errOut(e, send, logger); }
    },
    cron: async (q, send, ctx) => {
      const auth = (ctx && ctx.headers && ctx.headers.authorization) || '';
      if (!process.env.CRON_SECRET || !sameSecret(auth.replace(/^Bearer\s+/i, ''), process.env.CRON_SECRET)) return send(401, { error: 'unauthorized' });
      try { send(200, await (r.daily ? r.daily(baseUrl(ctx)) : r.collect(baseUrl(ctx)))); } catch (e) { errOut(e, send, logger); }
    },
    probe: async (q, send, ctx) => {
      if (!String(process.env.FELIX_ADMIN_TOKEN || '').trim()) return send(503, { error: 'not_configured', message: '서버에 FELIX_ADMIN_TOKEN이 없습니다. Vercel 환경변수(Production)에 넣고 Redeploy 하세요.' });
      if (!adminOk(ctx)) return send(401, { error: 'unauthorized', message: '토큰이 서버 값과 다릅니다. 입력한 토큰을 확인하세요.' });
      try { send(200, await r.probe()); } catch (e) { errOut(e, send, logger); }
    }
  };
}

module.exports = { createReport, makeReportHandlers, gradeChecks, weekLabel, sameSecret };
