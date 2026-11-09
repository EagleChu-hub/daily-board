// 南西每日戰力：時數計算、時段正規化、大班表解析
// 時數演算法逐步移植自戰力檔南西分頁 B11 公式（SUM(MAP(F3:F10, LAMBDA(x, LET(...)))))

const pad4 = (s) => s.padStart(4, '0');
const fmtNum = (n) => String(Math.round(n * 100) / 100);

/** 把 "2130" 這種 4 碼字串當作 TEXT(x,"00\:00") 後的時間，回傳「天」的小數；不合法回傳 null */
function hhmmToDay(s) {
  if (!/^\d{4}$/.test(s)) return null;
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2));
  if (m > 59) return null;
  return (h * 60 + m) / 1440;
}

/**
 * 依表單 B11 公式計算單一時段字串的時數。
 * 回傳 { hours, ok }。ok=false 代表表單公式在這個字串上會走到 IFERROR 備援分支（結果不可信）。
 */
export function sheetHours(x) {
  x = x == null ? '' : String(x);
  const p = x.indexOf('(');
  const main = p >= 0 ? x.slice(0, p) : x;
  const extra = p >= 0 ? x.slice(p) : '';
  const early = extra.includes('開早') ? 1 : 0;
  let h;
  if (main === '') h = 0;
  else if (main[0] === '休') {
    if (main.includes('-')) h = 13;
    else {
      const v = Number(main.slice(1, 11));
      h = Number.isFinite(v) ? v : 0;
    }
  } else if (main[0] === '例') h = 0;
  else {
    const dash = main.indexOf('-'); // SEARCH("-") 是 1-based，這裡 0-based
    if (dash < 4) return { hours: NaN, ok: false };
    const start = hhmmToDay(main.slice(dash - 4, dash));
    const end = hhmmToDay(main.slice(dash + 1, dash + 5));
    if (start == null || end == null) return { hours: NaN, ok: false };
    let diff = (((end - start) % 1) + 1) % 1; // MOD(...,1)
    h = diff * 24;
    const dashCount = (main.match(/-/g) || []).length;
    if (dashCount > 1) {
      const last = main.slice(main.lastIndexOf('-') + 1).trim();
      const ded = Number(last);
      if (!Number.isFinite(ded) || last === '') return { hours: NaN, ok: false };
      h -= ded;
    }
  }
  return { hours: Math.round((h + early) * 100) / 100, ok: true };
}

/** 加總多個時段的時數（等同 B11）。任何一筆 ok=false 就整體 ok=false */
export function totalHours(shifts) {
  let sum = 0;
  let ok = true;
  for (const s of shifts) {
    const r = sheetHours(s);
    if (!r.ok) { ok = false; continue; }
    sum += r.hours;
  }
  return { hours: Math.round(sum * 100) / 100, ok };
}

/**
 * 把大班表上的時段字串整理成表單公式吃得懂的格式：HHMM-HHMM[-扣休](HHMM-HHMM)
 * 回傳 { text, ok, notes[] }
 */
export function normalizeShift(raw) {
  const notes = [];
  let s = String(raw == null ? '' : raw)
    .replace(/[\r\n]+/g, '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[－—–~～]/g, '-')
    .replace(/\s+/g, '')
    .replace(/\(\)/g, '');
  if (s === '') return { text: '', ok: true, notes };
  const beforeColon = s;
  s = s.replace(/(\d{1,2}):(\d{2})/g, (_, h, m) => h.padStart(2, '0') + m);
  if (s !== beforeColon) notes.push('已去掉時間裡的冒號');
  const m = s.match(/^(\d{3,4})-(\d{3,4})(?:-(\d+(?:\.\d+)?))?(?:\((\d{3,4})-(\d{3,4})-?\)?)?(.*)$/);
  if (!m) return { text: s, ok: false, notes: [...notes, '時段格式無法辨識，請手動確認'] };
  let [, a, b, ded, wa, wb, rest] = m;
  a = pad4(a); b = pad4(b);
  if (hhmmToDay(a) == null || hhmmToDay(b) == null) {
    return { text: s, ok: false, notes: [...notes, '時間不合法，請手動確認'] };
  }
  let win = '';
  if (wa && wb) {
    wa = pad4(wa); wb = pad4(wb);
    const ws = hhmmToDay(wa), we = hhmmToDay(wb);
    if (ws == null || we == null) {
      notes.push('休息時段不合法，已略過');
    } else {
      win = `(${wa}-${wb})`;
      const winH = Math.round(((((we - ws) % 1) + 1) % 1) * 24 * 100) / 100;
      if (!ded) {
        ded = fmtNum(winH);
        notes.push(`依休息時段自動補扣 ${ded} 小時`);
      } else if (Number(ded) !== winH) {
        notes.push(`扣休 ${ded} 小時與休息時段 ${winH} 小時不同，保留原本的 ${ded}`);
      }
    }
  }
  rest = (rest || '').replace(/^\)+/, '');
  if (rest) notes.push(`已移除附註「${rest}」`);
  const text = `${a}-${b}${ded ? '-' + ded : ''}${win}`;
  return { text, ok: true, notes };
}

/** 簡易 CSV 解析（支援引號內換行與 ""） */
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export const STORE_WORDS = ['統一時代', '統一', '阪急', '板橋', '天母', '青埔', '忠孝', '信義', '竹北', '老虎城', '老虎', '中港', '大遠百', '台中'];
const SKIP_WORDS = ['休', '例', '病', '特休', '上課', '國定假日', '公假', '喪假', '婚假'];

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, '');

/** 找出表頭列（第 5 欄起是日期數字）對應的「欄 → 日期」 */
function headerDates(row, tabYear, tabMonth) {
  const days = [];
  for (let c = 4; c < row.length; c++) {
    const v = clean(row[c]);
    if (!/^\d{1,2}$/.test(v)) break;
    days.push({ col: c, day: Number(v) });
  }
  if (days.length < 7) return null;
  let rollIdx = -1;
  for (let i = 1; i < days.length; i++) if (days[i].day < days[i - 1].day) { rollIdx = i; break; }
  return days.map((d, i) => {
    let y = tabYear, mo = tabMonth;
    if (rollIdx > 0 && i < rollIdx) { mo -= 1; if (mo === 0) { mo = 12; y -= 1; } }
    return { col: d.col, date: `${y}-${String(mo).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` };
  });
}

/** 把格子內容拆成 { person, shiftRaw, text } —— 開頭若是文字就當作人名或地點 */
function splitCell(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, '').trim();
  const m = s.match(/^([^\d]*?)\s*(\d{1,2}:?\d{2}\s*[-－].*)$/);
  if (m) return { lead: m[1].trim(), shiftRaw: m[2], text: s };
  return { lead: s, shiftRaw: '', text: s };
}

const isStoreWord = (t) => STORE_WORDS.some((w) => t.startsWith(w) || t === w);

/**
 * 從大班表某個分頁的 CSV 列，取出指定日期（YYYY-MM-DD）的南西出勤名單。
 * 回傳 { found, people:[{name,titleRaw,shiftRaw,source,needsReview,notes[]}], warnings[] }
 */
export function extractRoster(rows, tabYear, tabMonth, dateStr, storeKey = '南西') {
  const warnings = [];
  // 1. 找南西區塊：A 欄去空白後含「南西」
  let anchor = -1;
  for (let r = 0; r < rows.length; r++) {
    if (clean(rows[r][0]).includes(storeKey)) { anchor = r; break; }
  }
  if (anchor < 0) return { found: false, people: [], warnings: [`在分頁裡找不到「${storeKey}」區塊`] };
  // 2. 往上找表頭
  let hdr = -1, map = null;
  for (let r = anchor; r >= 0 && r >= anchor - 6; r--) {
    const mp = headerDates(rows[r], tabYear, tabMonth);
    if (mp) { hdr = r; map = mp; break; }
  }
  if (!map) return { found: false, people: [], warnings: ['找不到南西區塊的日期表頭'] };
  const hit = map.find((m) => m.date === dateStr);
  if (!hit) return { found: false, people: [], warnings: [`這個分頁沒有 ${dateStr} 這一天`] };
  const col = hit.col;
  const otherStores = [...STORE_WORDS, '南西', '天母'].filter((w) => !storeKey.includes(w) && !w.includes(storeKey));
  // 防呆：星期列要對得上（避免分頁抓錯、月份推錯時默默帶錯人）
  const wdRow = rows[hdr + 1] || [];
  const wdText = clean(wdRow[col]);
  if (wdText) {
    const wd = '日一二三四五六'[new Date(dateStr + 'T00:00:00').getDay()];
    if (!wdText.includes(wd)) return { found: false, people: [], warnings: [`日期 ${dateStr} 應是星期${wd}，但班表寫「${wdText}」，可能抓錯分頁`] };
  }
  // 3. 區塊範圍：表頭下兩列（星期列之後）到「時數」列或下一個表頭
  const people = [];
  const seen = new Set();
  const add = (p) => {
    if (p.name && seen.has(p.name)) return;
    if (p.name) seen.add(p.name);
    people.push(p);
  };
  let end = rows.length;
  for (let r = hdr + 2; r < rows.length; r++) {
    const c2 = clean(rows[r][2]);
    if (c2 === '時數' || headerDates(rows[r], tabYear, tabMonth)) { end = r; break; }
  }
  for (let r = hdr + 2; r < end; r++) {
    const row = rows[r];
    const rowName = clean(row[2]);
    const titleRaw = clean(row[3]);
    const cell = row[col];
    const { lead, shiftRaw, text } = splitCell(cell);
    if (!text) continue;
    if (SKIP_WORDS.some((w) => clean(text).startsWith(w))) continue;
    const isSupportRow = rowName === '' || rowName === '支援人類' || /支援/.test(rowName);
    if (shiftRaw) {
      // 時段後面寫了別家店（例：天母區塊的「1030-2130南西」）→ 那天在別店，不算本店
      const tail = shiftRaw.replace(/^[\d:\s\-－().（）]+/, '');
      if (tail && otherStores.some((w) => tail.includes(w))) continue;
      if (lead && isStoreWord(lead)) { // 例：板橋1100-2100-1 → 去別店
        continue;
      }
      if (lead) { // 支援人員或借位：例「蕭廷偉1100-2000」「博仁 1230-2130-1」
        add({ name: lead, titleRaw: '', shiftRaw, source: `大班表 ${rowName || '支援列'}`, needsReview: !rowName || rowName !== lead, notes: [] });
      } else if (rowName && !isSupportRow) {
        add({ name: rowName, titleRaw, shiftRaw, source: '大班表', needsReview: false, notes: [] });
      } else {
        add({ name: '', titleRaw: '', shiftRaw, source: '大班表 支援列', needsReview: true, notes: ['沒有寫名字'] });
      }
    } else {
      // 沒有時段的文字
      if (isStoreWord(clean(text)) || clean(text).startsWith('回')) continue; // 去別店
      if (isSupportRow) add({ name: clean(text), titleRaw: '', shiftRaw: '', source: '大班表 支援列', needsReview: true, notes: ['只有名字沒有時段'] });
      else if (rowName) add({ name: clean(text), titleRaw: '', shiftRaw: '', source: `大班表 ${rowName} 那一列`, needsReview: true, notes: [`「${rowName}」那一列寫「${clean(text)}」，沒有時段`] });
    }
  }
  // 4. 其他區塊（店經理列、他店人員）同一天寫到「南西」的人 → 待確認
  for (let r = 0; r < rows.length; r++) {
    if (r >= hdr && r < end) continue;
    const v = rows[r][col];
    if (!v || !String(v).includes(storeKey)) continue;
    const name = clean(rows[r][2]) || clean(rows[r][0]);
    if (!name || name.includes(storeKey)) continue;
    const { shiftRaw } = splitCell(String(v).replace(storeKey, ''));
    add({ name, titleRaw: clean(rows[r][3]), shiftRaw, source: '大班表 他區塊寫「南西」', needsReview: true, notes: [`班表寫「${clean(v)}」`] });
  }
  return { found: true, people, warnings };
}

/** 依日期推算要試的分頁：{name, year, month} */
export function candidateTabs(dateStr, pattern = '季樂{M}月班表') {
  const [y, m] = dateStr.split('-').map(Number);
  const out = [];
  for (const d of [0, 1, -1]) {
    let mo = m + d, yy = y;
    if (mo > 12) { mo -= 12; yy += 1; }
    if (mo < 1) { mo += 12; yy -= 1; }
    out.push({ name: pattern.replace('{M}', mo), year: yy, month: mo });
  }
  return out;
}
