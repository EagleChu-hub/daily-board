// 每日戰力：紀錄、兩店設定、盤點帶入規則、送出資料組裝（頁面與測試共用）

export const recKey = (store, date) => `${store}|${date}`;

/** 設定碼 v1（只有南西）→ v2（stores: {南西, 天母}） */
export function migrateConfig(c) {
  if (!c) return null;
  if (c.stores) return c;
  const { beef, sea, titleOptions, names, titles, store = '南西', ...rest } = c;
  return { ...rest, v: 2, defaultStore: store, stores: { [store]: { beef, sea, titleOptions, names, titles, dateCellIsFormula: false } } };
}

/** 舊紀錄鍵是「YYYY-MM-DD」→ 一律歸到南西 */
export function migrateRecords(records) {
  const out = {};
  for (const [k, v] of Object.entries(records || {})) {
    out[/^\d{4}-\d{2}-\d{2}$/.test(k) ? recKey('南西', k) : k] = v;
  }
  return out;
}

/** 同一家店、日期早於 day 的紀錄，新到舊 */
export function prevRecords(records, store, day) {
  const pre = store + '|';
  return Object.entries(records)
    .filter(([k]) => k.startsWith(pre) && k.slice(pre.length) < day)
    .map(([k, rec]) => ({ date: k.slice(pre.length), rec }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

const filled = (v) => v != null && String(v).trim() !== '';

/**
 * 戰力檔快照（Apps Script ?action=stock 的一筆）→ 跟手機紀錄同形狀。
 * 盤點品項依「名稱」對到目前設定（戰力檔改了品名就對不到 → 留空，不會把湯料的數字塞給骰子牛）
 */
export function snapToRec(snap, sc) {
  const d = snap?.data || {};
  const pick = (kind) => (sc?.[kind] || []).map((it) => {
    const hit = (d[kind] || []).find((x) => x.name === it.name);
    return hit ? String(hit.qty ?? '') : '';
  });
  return { rev: d.rev ?? '', cust: d.cust ?? '', n88: d.n88 ?? '', staff: d.staff || [], beef: pick('beef'), sea: pick('sea') };
}

/**
 * 同店、日期早於 day 的歷史：手機紀錄＋戰力檔快照，新到舊。
 * 同一天兩邊都有 → 用手機的（她自己填的那份），source 標 'mine'；只有戰力檔有 → source 'sheet'
 */
export function mergedHistory(records, store, day, snaps = [], sc = null) {
  const mine = prevRecords(records, store, day).map((p) => ({ ...p, source: 'mine' }));
  const have = new Set(mine.map((p) => p.date));
  const sheet = (snaps || [])
    .filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date < day && !have.has(x.date))
    .map((x) => ({ date: x.date, rec: snapToRec(x, sc), source: 'sheet', seenAt: x.seenAt, dateFrom: x.dateFrom }));
  return [...mine, ...sheet].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * 新的一天的盤點預設值：carry:false 的品項留空；
 * 其他品項帶入同店最近一次「該品項有填」的數字——手機紀錄和戰力檔快照一起看，誰比較近用誰
 * （她休假、別人填的那天，數字從戰力檔來）
 */
export function carryStock(records, store, day, kind, items, snaps = []) {
  const prev = mergedHistory(records, store, day, snaps, { [kind]: items });
  return items.map((it, i) => {
    if (it.carry === false) return '';
    const hit = prev.find((p) => filled(p.rec[kind]?.[i]));
    return hit ? String(hit.rec[kind][i]) : '';
  });
}

/** 送出前檢查（回傳問題清單；空陣列才可送出） */
export function validateForSubmit(rec, scfg) {
  const p = [];
  if (!filled(rec.rev)) p.push('營業額(含稅) 還沒填');
  if (!filled(rec.cust)) p.push('來客數 還沒填');
  if (!filled(rec.n88)) p.push('88私房菜份數 還沒填（沒有就填 0）');
  if (rec.staff.length > 7) p.push(`明日戰力有 ${rec.staff.length} 人，表單只放得下 7 人`);
  if (rec.staff.some((s) => s.review)) p.push('明日戰力還有黃色待確認的人');
  if (rec.staff.some((s) => !s.name || !s.shift)) p.push('明日戰力有人名或時段空白');
  // 戰力檔 D、E 欄有下拉驗證（實測會「拒絕」清單外的值），送出前先擋，避免填到一半被試算表打回
  const badNames = rec.staff.filter((s) => s.name && scfg?.names?.length && !scfg.names.includes(s.name)).map((s) => s.name);
  if (badNames.length) p.push(`「${badNames.join('、')}」不在戰力檔的人名下拉清單，表單會拒絕。請刪掉，或請店長把人加進清單後告訴我更新設定碼`);
  const badTitles = rec.staff.filter((s) => s.title && scfg?.titleOptions?.length && !scfg.titleOptions.includes(s.title)).map((s) => `${s.name}「${s.title}」`);
  if (badTitles.length) p.push(`職稱不在下拉清單：${badTitles.join('、')}`);
  (scfg?.beef || []).forEach((it, i) => { if (!filled(rec.beef[i])) p.push(`盤點「${it.name}」還沒填（沒有就填 0）`); });
  (scfg?.sea || []).forEach((it, i) => { if (!filled(rec.sea[i])) p.push(`盤點「${it.name}」還沒填（沒有就填 0）`); });
  return p;
}

/** 組送出資料（語意化；由機器人依 layout 對應到儲存格） */
export function buildSubmitPayload({ store, day, rec, scfg, avg, slash, itemName }) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  const tmr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const staff = Array.from({ length: 7 }, (_, i) => {
    const s = rec.staff[i];
    return s ? { name: s.name, title: s.title || '', shift: s.shift } : { name: '', title: '', shift: '' };
  });
  return {
    store,
    date: day,
    todayText: slash(day),
    tomorrowText: slash(tmr),
    rev: String(rec.rev), cust: String(rec.cust), avg: avg == null ? '' : String(avg), n88: String(rec.n88),
    staff,
    allowedNames: scfg.names || [],
    allowedTitles: scfg.titleOptions || [],
    beef: (scfg.beef || []).map((it, i) => ({ name: itemName('beef', i), unit: it.unit, qty: String(rec.beef[i]) })),
    sea: (scfg.sea || []).map((it, i) => ({ name: itemName('sea', i), unit: it.unit, qty: String(rec.sea[i]) })),
  };
}
