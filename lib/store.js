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
 * 同一天兩邊都有 → 用戰力檔的（正式版；她或店長可能在試算表上改過），source 'sheet'；
 * 只有手機有 → source 'mine'
 */
export function mergedHistory(records, store, day, snaps = [], sc = null) {
  const sheet = (snaps || [])
    .filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date < day)
    .map((x) => ({ date: x.date, rec: snapToRec(x, sc), source: 'sheet', seenAt: x.seenAt, dateFrom: x.dateFrom }));
  const have = new Set(sheet.map((p) => p.date));
  const mine = prevRecords(records, store, day).filter((p) => !have.has(p.date)).map((p) => ({ ...p, source: 'mine' }));
  return [...mine, ...sheet].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * 這天的紀錄已經存在（例如先按了「從大班表帶入」）之後才拿到新的戰力檔資料：
 * 把「她沒親手改過」的盤點格重新帶入。親手改過的格子 rec.auto[kind][i] === false，不動。
 * 沒有旗標的格子（舊紀錄）→ 值等於「舊算法（只看手機紀錄）會帶入的數字」才視為自動帶入的。
 * 回傳有沒有改到東西。
 */
export function recarryStock(rec, records, store, day, sc, snaps = []) {
  let changed = false;
  rec.auto = rec.auto || {};
  for (const kind of ['beef', 'sea']) {
    const items = sc?.[kind] || [];
    const fresh = carryStock(records, store, day, kind, items, snaps);
    const flags = rec.auto[kind] || [];
    const legacy = carryStock(records, store, day, kind, items, []);
    // true＝自動帶入；false＝親手改過；沒有旗標（舊紀錄）→ 值跟舊算法帶入的一樣才算自動
    const auto = items.map((_, i) => (flags[i] === true || flags[i] === false ? flags[i] : String(rec[kind]?.[i] ?? '') === legacy[i]));
    rec[kind] = rec[kind] || [];
    items.forEach((_, i) => {
      if (auto[i] && String(rec[kind][i] ?? '') !== fresh[i]) { rec[kind][i] = fresh[i]; changed = true; }
    });
    rec.auto[kind] = auto;
  }
  return changed;
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

/**
 * 舊紀錄（沒有 auto 旗標）一次補上旗標：值跟「舊算法（只看手機紀錄）會帶入的數字」一樣 → 自動帶入的(true)，
 * 不一樣 → 她親手改過(false)。要在任何一天被戰力檔數字取代之前做（只加旗標、不改數字，所以順序無關）。
 * 回傳補了幾筆。
 */
export function markLegacyAuto(records, cfg) {
  let n = 0;
  for (const [k, rec] of Object.entries(records || {})) {
    const [store, date] = k.split('|');
    const sc = cfg?.stores?.[store];
    if (!sc || !rec) continue;
    for (const kind of ['beef', 'sea']) {
      if (rec.auto?.[kind]) continue;
      const items = sc[kind] || [];
      const legacy = carryStock(records, store, date, kind, items, []);
      rec.auto = rec.auto || {};
      rec.auto[kind] = items.map((_, i) => String(rec[kind]?.[i] ?? '') === legacy[i]);
      n++;
    }
  }
  return n;
}

/**
 * 打開某一天：她手機有紀錄、戰力檔也有這天，而且戰力檔的比較新（試算表上後來被改過）
 * → 營業額／來客／88／盤點改用戰力檔的數字（明日戰力人員保留手機的）。
 * 比較依據：rec.savedAt（她最後在手機上改的時間）vs snap.seenAt（雲端第一次讀到這組數字的時間）；
 * 舊紀錄沒有 savedAt → 戰力檔優先。opt.hold＝true 時一律不套用。回傳有沒有改到東西。
 */
export function applySheetDay(rec, snap, sc, opt = {}) {
  if (opt.hold) return false; // 她今天的小抄貼到一半：戰力檔上是半成品，先不採用
  if (!rec || !snap?.seenAt) return false;
  if (rec.savedAt && rec.savedAt >= snap.seenAt) return false;
  const s = snapToRec(snap, sc);
  let changed = false;
  for (const k of ['rev', 'cust', 'n88']) if (String(rec[k] ?? '') !== String(s[k] ?? '')) { rec[k] = s[k]; changed = true; }
  rec.auto = rec.auto || {};
  for (const kind of ['beef', 'sea']) {
    if (JSON.stringify(rec[kind] || []) !== JSON.stringify(s[kind])) { rec[kind] = s[kind]; changed = true; }
    rec.auto[kind] = s[kind].map(() => false); // 正式數字，不再被「帶入」蓋掉
  }
  rec.savedAt = snap.seenAt;
  return changed;
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

/**
 * App 從背景叫回來時要不要換日：她原本停在「當時的今天」而今天已經換了 → 回傳新的今天；
 * 她特地翻到別天在看、或沒換日 → 回傳原本那天（不動）。
 */
export function resumeDay(viewDay, prevToday, nowToday) {
  return prevToday !== nowToday && viewDay === prevToday ? nowToday : viewDay;
}

/** 產 LINE 圖前的提醒（只提醒不擋）：送出前檢查那一套，再加「明日戰力還沒有人」 */
export function validateForImage(rec, scfg) {
  const p = validateForSubmit(rec, scfg);
  if (!rec.staff.length) p.unshift('明日戰力還沒有人（還沒按「從大班表帶入」？）');
  return p;
}

/**
 * 小抄步驟（每步＝在試算表點一格貼上）。公式格（B5、B10、B11、D14:D19）隔在中間，所以不能合成一整塊。
 * 人名＋職稱（D4）和時段（F4）不能合成一步：2026-11-11 在測試副本實測，貼進 F:H 合併格會把合併拆掉
 * （robot/tools/paste-test.mjs；三欄一起貼、單欄貼、僅貼上值，在電腦版網頁都會拆）。
 */
export function buildPasteSteps({ rec, scfg, avg, todayText, tomorrowText }) {
  const rows7 = Array.from({ length: 7 }, (_, i) => rec.staff[i] || { name: '', title: '', shift: '' });
  const col = (kind) => (scfg?.[kind] || []).map((_, i) => rec[kind]?.[i] ?? '').join('\n');
  const steps = [];
  if (!scfg?.dateCellIsFormula) steps.push({ cell: 'A2', what: '今天日期', text: todayText });
  if (!scfg?.tomorrowCellIsFormula) steps.push({ cell: 'F2', what: '明天日期', text: tomorrowText });
  steps.push(
    { cell: 'B3', what: '營業額(含稅)', text: String(rec.rev ?? '') },
    { cell: 'B7', what: '來客數／平均客單／88份數（3 格往下）', text: [rec.cust, avg ?? '', rec.n88].join('\n') },
  );
  steps.push(
    { cell: 'D4', what: '人名＋職稱（2 欄×7 列，空的會清掉舊資料）', text: rows7.map((s) => `${s.name}\t${s.title}`).join('\n') },
    { cell: 'F4', what: '時段（7 列）', text: rows7.map((s) => s.shift).join('\n') },
  );
  steps.push(
    { cell: 'B14', what: '牛肉數量（6 格往下）', text: col('beef') },
    { cell: 'F14', what: '海鮮/雞腿數量（6 格往下）', text: col('sea') },
  );
  return steps;
}
