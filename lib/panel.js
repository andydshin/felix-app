'use strict';
// 가격 패널 관심 등록. 실거래가 제출은 법률 검토(공정거래법상 정보교환 담합) 뒤에 연다. 지금은 연락처만 받는다.
//  POST /api/panel  { phone, company?, role?, items[]?, consent:true }   휴대폰만 필수. 회사명은 선택(정식 패널 가입 때 사업자 확인과 함께 받는다)
//  저장: KV 'panel:v1' = [{ id, phone, company, role, items, at, updatedAt }]  (휴대폰 번호 해시로 중복 제거, 최대 5000건)
//  개인정보: 휴대폰 번호·회사명은 패널 안내 연락에만 쓴다. 관리자 화면(토큰 필요)에서만 보인다. 공개 응답에는 건수조차 내보내지 않는다.
const crypto = require('crypto');
const KEY = 'panel:v1';
const ROLES = ['유통', '실수요', '제조', '기타'];
const ITEMS = ['hr', 'cr', 'gi', 'rb', 'hb', 'plate', 'pipe', 'sts'];
const MAX = 5000;

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const phoneOf = v => { let d = String(v == null ? '' : v).replace(/\D/g, ''); if (d.startsWith('8210')) d = '0' + d.slice(2); return /^01[016789]\d{7,8}$/.test(d) ? d : null; };
const fmtPhone = d => d.length === 11 ? d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7) : d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);

function createPanel(opts) {
  const kv = opts.kv, now = opts.now || (() => new Date());
  return {
    async register(b) {
      b = b || {};
      const phone = phoneOf(b.phone), company = clean(b.company, 80), role = ROLES.includes(b.role) ? b.role : '';
      const items = (Array.isArray(b.items) ? b.items : []).filter(k => ITEMS.includes(k)).slice(0, ITEMS.length);
      if (!phone) return { ok: false, error: 'phone', message: '휴대폰 번호를 확인하세요. 예: 010-1234-5678' };
      if (b.consent !== true) return { ok: false, error: 'consent', message: '연락 동의가 필요합니다.' };
      const id = crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
      const list = (await kv.get(KEY)) || [];
      const at = now().toISOString(), i = list.findIndex(x => x.id === id);
      if (i >= 0) list[i] = Object.assign({}, list[i], { company: company || list[i].company || '', role: role || list[i].role || '', items: items.length ? items : (list[i].items || []), updatedAt: at });
      else { if (list.length >= MAX) return { ok: false, error: 'full', message: '잠시 후 다시 시도하세요.' }; list.push({ id, phone: fmtPhone(phone), company, role, items, at }); }
      await kv.set(KEY, list);
      return { ok: true, updated: i >= 0 };
    },
    async list() { const l = (await kv.get(KEY)) || []; return { count: l.length, items: l.slice().reverse() }; }
  };
}

module.exports = { createPanel, phoneOf, ROLES, ITEMS };
