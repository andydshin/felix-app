'use strict';
// 의존성 없는 아주 작은 xlsx 읽기: zip(중앙 디렉터리) → 시트 XML → 셀 값. 세계은행 월간 가격표처럼 단순한 표에 충분하다.
const zlib = require('zlib');

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    files[name] = { method, csize, off };
    p += 46 + nlen + elen + clen;
  }
  return name => {
    const f = files[name];
    if (!f) return null;
    const lnlen = buf.readUInt16LE(f.off + 26), lelen = buf.readUInt16LE(f.off + 28);
    const start = f.off + 30 + lnlen + lelen;
    const data = buf.slice(start, start + f.csize);
    return (f.method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
  };
}

function decode(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function colIndex(ref) { const L = ref.replace(/\d+/g, ''); let n = 0; for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

// 시트 이름 → 2차원 배열(문자열/숫자)
function readSheet(buf, sheetName) {
  const get = unzip(buf);
  const wb = get('xl/workbook.xml') || '';
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const sheets = [...wb.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(m => ({ name: decode(m[1]), rid: m[2] }));
  const want = sheets.find(s => s.name === sheetName) || sheets.find(s => s.name.toLowerCase().includes(String(sheetName).toLowerCase()));
  if (!want) throw new Error('sheet not found: ' + sheetName + ' (have ' + sheets.map(s => s.name).join(', ') + ')');
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(r => r.includes('Id="' + want.rid + '"'));
  let target = (rel.match(/Target="([^"]+)"/) || [])[1];
  target = target.replace(/^\//, '');
  if (!target.startsWith('xl/')) target = 'xl/' + target;
  const ss = get('xl/sharedStrings.xml') || '';
  const strings = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const xml = get(target);
  if (!xml) throw new Error('sheet xml missing: ' + target);
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const ri = Number(r[1]) - 1, row = [];
    for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] || '';
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      if (!ref) continue;
      const t = (attrs.match(/t="([^"]+)"/) || [])[1];
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = null;
      if (t === 's') val = strings[Number(v)];
      else if (t === 'inlineStr') val = decode([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
      else if (t === 'str') val = v != null ? decode(v) : null;
      else if (v != null) val = Number(v);
      row[colIndex(ref)] = val;
    }
    rows[ri] = row;
  }
  return rows;
}

module.exports = { readSheet, unzip };
