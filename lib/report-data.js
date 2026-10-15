'use strict';
// 주간 리포트용 숫자 묶음. 앱이 쓰는 같은 /api/* 응답을 받아 한 가지 모양(행)으로 바꾼 뒤
//  - 많이 움직인 품목(시장가·물가지수만. 수입 단가는 품목 구성 영향이 커서 제외)
//  - 원료 → 제품 흐름
//  - 지역별 핵심 숫자, 국가별 대표 철강재 전월비(차트용)
// 을 계산한다. 계산은 모두 여기서 하고, AI는 이 숫자를 인용만 한다.

const LABEL = {
  hr: '열연', cr: '냉연', coated: '도금강판', plate: '후판', wire_rod: '선재', rebar: '철근', section: '형강', pipe: '강관', sts: '스테인리스',
  steel: '철강재 전체', alloy_flat: '합금강 판재', iron_ore: '철광석', coking_coal: '원료탄', coal: '석탄', coke: '코크스', scrap: '고철',
  al: '알루미늄', cu: '전기동', zn: '아연', ni: '니켈', pb: '납', sn: '주석', cn_supply: '중국산 철강재 수입량', usdkrw: '원/달러'
};
const REGION = { kr: '한국', us: '미국', cn: '중국', in: '인도', mx: '멕시코', jp: '일본', eu: '유럽', world: '세계', fx: '환율' };
const RAW = ['iron_ore', 'coking_coal', 'coke', 'scrap'];
const NF = ['al', 'cu', 'zn', 'ni', 'pb', 'sn'];

const r2 = v => Math.round(v * 100) / 100;
const pctOf = (v, p) => (Number.isFinite(v) && Number.isFinite(p) && p !== 0 ? r2((v - p) / p * 100) : null);

// 행: { key, region, item, label, value, prev, unit, pct, period, kind: 'price'|'index'|'unit'|'volume', basis, low }
function row(region, item, o) {
  const value = o.value == null ? null : Number(o.value), prev = o.prev == null ? null : Number(o.prev);
  return Object.assign({ key: region + ':' + item, region, regionName: REGION[region], item, label: LABEL[item] || item, value, prev, pct: pctOf(value, prev), low: !!o.low }, o, { value, prev });
}

const ADAPT = {
  // 중국 국가통계국 유통가(열흘)
  cn(j) {
    const ids = { cn1: 'rebar', cn2: 'wire_rod', cn3: 'plate', cn4: 'hr', cn5: 'pipe', cn6: 'section', cn7: 'coking_coal', cn8: 'coke', cu: 'cu', al: 'al', pb: 'pb', zn: 'zn' };
    const p = j.period || {}, per = p.year ? p.year + '-' + String(p.month).padStart(2, '0') + ' ' + ({ '上旬': '상순', '中旬': '중순', '下旬': '하순' }[p.part] || '') : '';
    return Object.keys(ids).filter(k => j.items && j.items[k]).map(k => row('cn', ids[k], { value: j.items[k].price, prev: j.items[k].prev, unit: '위안/t', period: per.trim(), kind: 'price', basis: '유통 시장가(열흘 전 대비)' }));
  },
  // 한국 생산자물가(KOSIS)
  krPpi(j) {
    const ids = { kr1: 'rebar', kr2: 'section', kr3: 'hr', kr4: 'cr', kr5: 'coated', kr6: 'plate', kr7: 'pipe', kr8: 'sts' };
    return (j.items || []).filter(i => i.status === 'ok' && ids[i.id]).map(i => row('kr', ids[i.id], { value: i.value, prev: i.prev, unit: '지수', period: i.period, kind: 'index', basis: '생산자물가지수' }));
  },
  // 한국 수입 통관 단가(관세청)
  krTrade(j) {
    const ids = { imp1: 'hr', imp2: 'cr', imp3: 'coated', imp4: 'alloy_flat', imp5: 'wire_rod', imp6: 'rebar', imp7: 'section', imp8: 'sts', imp9: 'scrap', nf1: 'al', nf2: 'cu', nf3: 'zn', nf4: 'pb', nf5: 'sn', nf6: 'ni', raw3: 'iron_ore', raw4: 'coking_coal', sd1: 'cn_supply' };
    return (j.items || []).filter(i => i.status === 'ok' && ids[i.id]).map(i => {
      const pv = i.prev && i.prev.status === 'ok' ? i.prev : null;
      if (i.id === 'sd1') return row('kr', 'cn_supply', { value: i.tons, prev: pv ? pv.tons : null, unit: 't', period: j.month, kind: 'volume', basis: '수입 물량' });
      return row('kr', ids[i.id], { key: 'krimp:' + ids[i.id], value: i.unitPrice, prev: pv && !pv.lowVolume ? pv.unitPrice : null, unit: '달러/t', period: j.month, kind: 'unit', basis: '수입 통관 단가', low: !!i.lowVolume, tons: i.tons });
    });
  },
  // 미국 생산자물가(BLS)
  usPpi(j) {
    const ids = { gl1: 'steel', gl2: 'cr', gl3: 'scrap', gl4: 'plate', gl5: 'pipe' };
    return (j.items || []).filter(i => i.status === 'ok' && ids[i.id]).map(i => row('us', ids[i.id], { value: i.value, prev: i.prev, unit: '지수', period: i.period, kind: 'index', basis: '생산자물가지수' }));
  },
  // 세계은행 월평균
  world(j) {
    const ids = { iron_ore: 'iron_ore', coal_au: 'coal', al: 'al', cu: 'cu', pb: 'pb', sn: 'sn', ni: 'ni', zn: 'zn' };
    return Object.keys(ids).filter(k => j.items && j.items[k]).map(k => row('world', ids[k], { value: j.items[k].value, prev: j.items[k].prev, unit: '달러/t', period: j.items[k].period, kind: 'price', basis: '국제 월평균가' }));
  },
  // 인도 도매물가
  india(j) {
    return Object.keys(j.items || {}).filter(k => LABEL[k]).map(k => row('in', k, { value: j.items[k].value, prev: j.items[k].prev, unit: '지수', period: j.items[k].period, kind: 'index', basis: '도매물가지수' }));
  },
  // 멕시코: 미국의 멕시코산 수입 단가
  mx(j) {
    return Object.keys(j.items || {}).filter(k => j.items[k].status === 'ok' && LABEL[k]).map(k => { const i = j.items[k]; return row('mx', k, { value: i.unitPrice, prev: i.prev && !i.prev.lowVolume ? i.prev.unitPrice : null, unit: '달러/t', period: j.month, kind: 'unit', basis: '대미 수출 단가', low: !!i.lowVolume }); });
  },
  // 일본 무역통계 단가
  jp(j) {
    return (j.items || []).filter(i => i.status === 'ok' && LABEL[i.id]).map(i => row('jp', i.id === 'coal' ? 'coking_coal' : i.id, { value: i.unitPriceJpy, prev: i.prev && i.prev.status === 'ok' && !i.prev.lowVolume ? i.prev.unitPriceJpy : null, unit: '엔/t', period: i.month, kind: 'unit', basis: i.flow === 'export' ? '수출 단가' : '수입 단가', low: !!i.lowVolume }));
  },
  // 유럽: 역외 수입 단가, 없으면 PPI 업종
  eu(j) {
    return Object.keys(j.items || {}).filter(k => LABEL[k]).map(k => {
      const c = j.items[k].comext || {}, p = j.items[k].ppi;
      if (c.status === 'ok' && !c.lowVolume) return row('eu', k, { value: c.unitPrice, prev: c.prev && !c.prev.lowVolume ? c.prev.unitPrice : null, unit: '유로/t', period: c.period, kind: 'unit', basis: '역외 수입 단가' });
      if (p) return row('eu', k, { value: p.value, prev: p.prev, unit: '지수', period: p.period, kind: 'index', basis: 'PPI 업종(' + p.nace + ')' });
      return null;
    }).filter(Boolean);
  },
  fx(j) {
    if (!j.rates || !j.rates.USD) return [];
    return [row('fx', 'usdkrw', { value: j.rates.USD, prev: j.prevRates && j.prevRates.USD, unit: '원', period: j.date, kind: 'price', basis: '매매기준율(전 영업일 대비)' })];
  }
};

// 소스 이름 → 경로·어댑터
const SOURCES = [
  { id: 'cn', path: '/api/cn-prices', adapt: 'cn' }, { id: 'krPpi', path: '/api/kr-ppi', adapt: 'krPpi' }, { id: 'krTrade', path: '/api/kr-trade', adapt: 'krTrade' },
  { id: 'usPpi', path: '/api/us-ppi', adapt: 'usPpi' }, { id: 'world', path: '/api/world-prices', adapt: 'world' }, { id: 'india', path: '/api/in-wpi', adapt: 'india' },
  { id: 'mx', path: '/api/mx-trade', adapt: 'mx' }, { id: 'jp', path: '/api/jp-trade', adapt: 'jp' }, { id: 'eu', path: '/api/eu-prices', adapt: 'eu' }, { id: 'fx', path: '/api/fx-daily', adapt: 'fx' }
];

function normalize(raw) {
  const rows = [], status = {};
  SOURCES.forEach(s => {
    const j = raw[s.id];
    if (!j || j.error) { status[s.id] = j && j.error ? 'error:' + j.error : 'missing'; return; }
    try { const r = ADAPT[s.adapt](j); rows.push(...r); status[s.id] = 'ok:' + r.length; } catch (e) { status[s.id] = 'adapt-error'; }
  });
  return { rows, status };
}

function pick(rows, key) { return rows.find(r => r.key === key) || null; }

function analyze(rows) {
  const moving = rows.filter(r => r.pct != null && !r.low && (r.kind === 'price' || r.kind === 'index') && r.region !== 'fx');
  const sorted = moving.slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const movers = { up: sorted.filter(r => r.pct > 0).slice(0, 5), down: sorted.filter(r => r.pct < 0).slice(0, 5) };
  // 원료 → 제품: 국제가와 중국 내수가 중심, 없으면 다른 지역
  const first = keys => keys.map(k => pick(rows, k)).find(r => r && r.pct != null) || null;
  const flow = {
    raw: [first(['world:iron_ore', 'krimp:iron_ore']), first(['cn:coking_coal', 'world:coal']), first(['cn:coke', 'eu:coke']), first(['us:scrap', 'krimp:scrap', 'eu:scrap'])].filter(Boolean),
    product: [first(['cn:hr']), first(['cn:rebar']), first(['kr:hr']), first(['us:steel']), first(['in:hr'])].filter(Boolean)
  };
  // 국가별 대표 철강재(열연, 미국은 철강재 전체) 전월비
  const repKey = { kr: 'kr:hr', us: 'us:steel', cn: 'cn:hr', in: 'in:hr', mx: 'mx:hr', jp: 'jp:hr', eu: 'eu:hr' };
  const chart = Object.keys(repKey).map(k => { const r = pick(rows, repKey[k]); return { region: k, regionName: REGION[k], label: r ? r.label : '열연', pct: r && !r.low ? r.pct : null, period: r ? r.period : null, basis: r ? r.basis : null }; });
  // 지역별 핵심 숫자(지역마다 최대 4개)
  const want = ['hr', 'steel', 'rebar', 'plate', 'cr', 'coated', 'pipe', 'scrap', 'iron_ore', 'coking_coal', 'coke', 'cu', 'al', 'ni'];
  const regions = ['cn', 'kr', 'us', 'eu', 'jp', 'in', 'mx', 'world'].map(rg => {
    const rs = rows.filter(r => r.region === rg && r.pct != null && !r.low && r.kind !== 'volume')
      .sort((a, b) => want.indexOf(a.item) - want.indexOf(b.item) || (a.kind === 'unit') - (b.kind === 'unit')).filter(r => want.includes(r.item));
    // 한국은 물가지수와 수입 단가가 둘 다 'kr' → 물가지수 우선
    const seen = new Set();
    const pickd = rs.filter(r => (seen.has(r.item) ? false : (seen.add(r.item), true))).slice(0, 4);
    return { region: rg, regionName: REGION[rg], rows: pickd };
  }).filter(r => r.rows.length);
  return { movers, flow, chart, regions, fx: pick(rows, 'fx:usdkrw'), cnSupply: pick(rows, 'kr:cn_supply') };
}

// 다음 2주 안의 정기 발표 일정(대략 날짜, '경')
function releaseCalendar(from) {
  const out = [];
  const add = (d, title, why) => out.push({ date: d.toISOString().slice(0, 10), title, why, approx: true, kind: 'release' });
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i));
    const day = d.getUTCDate();
    if ([4, 14, 24].includes(day)) add(d, '중국 국가통계국 열흘 유통가격', '중국 열연·철근·원료탄·코크스 내수가 방향');
    if (day === 15) add(d, '관세청 전월 수입 통관 단가', '중국산 열연 등 수입재 도착 단가');
    if (day === 14) add(d, '인도 도매물가(WPI)', '인도 철강재·원료 가격 흐름');
    if (day === 16) add(d, '미국 BLS 생산자물가(PPI)', '미국 철강재·고철 가격 흐름');
    if (day === 21) add(d, '한국은행 생산자물가', '국내 철강재 출고가 흐름');
    if (day === 3) add(d, '세계은행 월평균 국제가격', '철광석·석탄·비철 국제가');
  }
  return out;
}

// AI 없이 숫자만으로 쓰는 기본 초안(사실 문장만). 대표님이 다듬는 출발점.
function autoSummary(a) {
  const f = p => (p > 0 ? '▲' : '▼') + Math.abs(p).toFixed(1) + '%';
  const nm = r => r.regionName + ' ' + r.label;
  const up = a.movers.up[0], dn = a.movers.down[0];
  const title = [dn && nm(dn) + ' ' + f(dn.pct), up && nm(up) + ' ' + f(up.pct)].filter(Boolean).join(', ') || '이번 주 철강 가격 흐름';
  const tone = rs => { const u = rs.filter(r => r.pct > 0).length, d = rs.filter(r => r.pct < 0).length; return !rs.length ? null : u && !d ? '올랐다' : d && !u ? '내렸다' : u > d ? '대체로 올랐다' : d > u ? '대체로 내렸다' : '엇갈렸다'; };
  const rt = tone(a.flow.raw), pt = tone(a.flow.product);
  const oneLiner = [rt && '원료 가격은 ' + rt + '.', pt && '철강 제품 가격은 ' + pt + '.'].filter(Boolean).join(' ');
  const takeaways = [];
  if (up) takeaways.push('가장 많이 오른 것은 ' + nm(up) + '(' + f(up.pct) + ', ' + up.period + ')이다.');
  if (dn) takeaways.push('가장 많이 내린 것은 ' + nm(dn) + '(' + f(dn.pct) + ', ' + dn.period + ')이다.');
  if (a.fx && a.fx.pct != null) takeaways.push('원/달러는 ' + Number(a.fx.value).toLocaleString('ko-KR') + '원으로 ' + f(a.fx.pct) + ' 움직였다.');
  else if (a.cnSupply && a.cnSupply.pct != null) takeaways.push('중국산 철강재 수입량은 ' + f(a.cnSupply.pct) + ' 변했다.');
  const regions = a.regions.map(g => ({ region: g.region, text: g.regionName + ' 가격은 ' + (tone(g.rows) || '변화가 없었다') + '. ' + g.rows.map(r => r.label + ' ' + f(r.pct) + '(' + r.period + ')').join(', ') + '.' }));
  // 숫자만으로 쓴 짧은 기사(대표님이 다듬거나 Claude 답으로 교체)
  const body = [];
  if (a.flow.raw.length) body.push('원료 쪽에서는 ' + a.flow.raw.map(r => nm(r) + '이 ' + f(r.pct)).join(', ') + ' 움직였다.');
  if (a.flow.product.length) body.push('제품 가격은 ' + a.flow.product.map(r => nm(r) + ' ' + f(r.pct)).join(', ') + '로 집계됐다.');
  if (a.fx && a.fx.pct != null) body.push('원/달러 환율은 ' + Number(a.fx.value).toLocaleString('ko-KR') + '원으로 ' + f(a.fx.pct) + ' 움직여 수입재 원화 가격에 영향을 줬다.');
  body.push('다음 확인 지점은 중국 국가통계국의 다음 열흘 가격과 관세청 월간 수입 단가다.');
  const article = { lede: [up && nm(up) + '이 ' + f(up.pct) + ' 오르며 이번 주 가장 크게 움직였다.', dn && nm(dn) + '은 ' + f(dn.pct) + '로 가장 많이 내렸다.'].filter(Boolean).join(' '), body };
  return { title, oneLiner, takeaways, regions, article };
}

module.exports = { autoSummary, normalize, analyze, releaseCalendar, SOURCES, LABEL, REGION, RAW, NF, pctOf };
