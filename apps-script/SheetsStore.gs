/**
 * 所有分頁的讀寫都集中在這裡，其他檔案不要直接碰 SpreadsheetApp。
 * 這個工具的資料量（幾千~幾萬列）遠低於「需要真正索引」的門檻，
 * 策略就是整張分頁讀進記憶體、用物件當 key 比對，寫回去用 setValues 整批寫。
 */

var SHEETS = {
  INTERESTS: 'Interests',
  CATEGORIES: 'Categories',
  SNAPSHOTS: 'Snapshots',
  RELATED_CACHE: 'RelatedCache',
  OVERLAP_CACHE: 'OverlapCache',
  SEED_KEYWORDS: 'SeedKeywords',
};

var SHEET_HEADERS = {
  Interests: ['id', 'name', 'path', 'audience_size_lower_bound', 'audience_size_upper_bound', 'topic', 'description', 'first_seen_at', 'last_seen_at', 'last_snapshot_id'],
  Categories: ['id', 'name', 'path', 'audience_size_lower_bound', 'audience_size_upper_bound', 'last_seen_at'],
  Snapshots: ['snapshot_id', 'started_at', 'finished_at', 'keywords_used_count', 'interests_found_count', 'new_interest_ids', 'removed_interest_ids', 'status'],
  RelatedCache: ['seed_interest_id', 'related_json', 'computed_at'],
  OverlapCache: ['pair_key', 'interest_a', 'interest_b', 'size_a', 'size_b', 'size_intersection', 'overlap_ratio', 'computed_at'],
  SeedKeywords: ['keyword'],
};

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** 取得分頁，不存在就自動建立並補上表頭 */
function getSheet_(name) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    var headers = SHEET_HEADERS[name];
    if (headers) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

/** 把整張分頁讀成 [{header: value, ...}, ...]，第一列當表頭 */
function readSheetAsObjects_(name) {
  var sheet = getSheet_(name);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[i][j];
    }
    rows.push(obj);
  }
  return rows;
}

/** 依 keyField 建立 { keyValue: {rowIndex(1-based, 含表頭), data} } 的查找表 */
function indexSheetByKey_(name, keyField) {
  var sheet = getSheet_(name);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var index = {};
  if (lastRow < 2 || lastCol < 1) return { sheet: sheet, headers: SHEET_HEADERS[name], index: index };
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0];
  var keyCol = headers.indexOf(keyField);
  for (var i = 1; i < values.length; i++) {
    var key = String(values[i][keyCol]);
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    index[key] = { rowNumber: i + 1, data: obj };
  }
  return { sheet: sheet, headers: headers, index: index };
}

/**
 * 依 keyField 把 rows 陣列 upsert 進分頁：已存在的 key 覆寫該列，
 * 不存在的 append 到底部。適合「找到就更新 last_seen_at，沒找到就新增」這種批次寫入。
 */
function upsertRows_(name, keyField, rows) {
  if (!rows.length) return;
  var headers = SHEET_HEADERS[name];
  var ctx = indexSheetByKey_(name, keyField);
  var sheet = ctx.sheet;
  var toAppend = [];

  rows.forEach(function (row) {
    var key = String(row[keyField]);
    var existing = ctx.index[key];
    var rowArray = headers.map(function (h) { return row[h] !== undefined ? row[h] : ''; });
    if (existing) {
      sheet.getRange(existing.rowNumber, 1, 1, headers.length).setValues([rowArray]);
    } else {
      toAppend.push(rowArray);
    }
  });

  if (toAppend.length) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, toAppend.length, headers.length).setValues(toAppend);
  }
}

function appendRow_(name, row) {
  var headers = SHEET_HEADERS[name];
  var sheet = getSheet_(name);
  var rowArray = headers.map(function (h) { return row[h] !== undefined ? row[h] : ''; });
  sheet.appendRow(rowArray);
}

function getSeedKeywords_() {
  return readSheetAsObjects_(SHEETS.SEED_KEYWORDS)
    .map(function (r) { return String(r.keyword || '').trim(); })
    .filter(function (k) { return k.length > 0; });
}
