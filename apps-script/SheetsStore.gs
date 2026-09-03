/**
 * 所有分頁的讀寫都集中在這裡，其他檔案不要直接碰 SpreadsheetApp。
 * 這個工具的資料量（幾千~幾萬列）遠低於「需要真正索引」的門檻，
 * 策略就是整張分頁讀進記憶體、用物件當 key 比對，寫回去用 setValues 整批寫。
 *
 * SeedKeywords 直接存於這份「資料庫」試算表內（SeedKeywords 分頁）。
 * 若分頁不存在或為空，系統會自動建立並寫入 166 個預設種子關鍵字。
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

var DEFAULT_SEED_KEYWORDS = [
  '手機', '筆記型電腦', '平板電腦', '智慧型手錶', '藍芽耳機', '遊戲主機', '相機', '空拍機',
  '智慧家庭', '電競', 'iPhone', 'Samsung', 'PlayStation', 'Nintendo Switch', 'Xbox',
  '保養品', '彩妝', '香水', '護膚', '美白', '抗老', '面膜', '精華液', '美甲', '美睫',
  '醫美', '微整形', '美妝', '時尚', '穿搭', '精品', '名牌包', '手錶', '珠寶', '球鞋',
  '潮流服飾', 'Zara', 'Uniqlo', 'Nike', 'Adidas', '快時尚', '旅遊', '自助旅行', '露營',
  '背包客', '訂房', '機票', '郵輪', '潛水', '衝浪', '露營車', '國內旅遊', '日本旅遊',
  '歐洲旅遊', 'Airbnb', '飯店', '健身', '重訓', '瑜珈', '跑步', '馬拉松', '自行車',
  '游泳', '登山', '攀岩', '拳擊', '皮拉提斯', '高爾夫球', '網球', '籃球', '足球',
  '棒球', '運動營養品', '健身房', '親子', '育兒', '懷孕', '母嬰用品', '尿布', '奶粉',
  '兒童玩具', '幼兒園', '兒童教育', '親子旅遊', '寶寶副食品', '手機遊戲', '電玩', 'Steam',
  '任天堂', '桌遊', '卡牌遊戲', '英雄聯盟', '原神', '投資', '理財', '股票', '基金',
  '保險', '信用卡', '加密貨幣', '比特幣', '房地產投資', '退休規劃', '記帳', '寵物',
  '狗', '貓', '寵物用品', '寵物食品', '寵物美容', '水族', '美食', '咖啡', '甜點',
  '烘焙', '素食', '餐廳', '小吃', '精釀啤酒', '紅酒', '調酒', '料理', '食譜',
  '居家裝潢', '家具', '家電', '收納', '園藝', 'DIY', '室內設計', '廚房用品', '電影',
  '韓劇', '動漫', '音樂', 'Podcast', 'YouTube', 'Netflix', '演唱會', 'K-pop', '攝影',
  '單眼相機', '底片攝影', '繪畫', '藝術', '手作', '陶藝', '書法', '汽車', '機車',
  '電動車', '改裝車', 'Tesla', '線上課程', '語言學習', '英文學習', '程式設計', '讀書會',
  '職涯發展', '證照考試', '健康飲食', '減重', '睡眠', '心理健康', '中醫', '營養補充品'
];

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

/**
 * 讀取種子關鍵字清單。
 * 直接從目前「資料庫」試算表的 SeedKeywords 分頁讀取。
 * 若分頁不存在或為空，會自動建立分頁並寫入 166 個預設關鍵字。
 */
function getSeedKeywords_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SHEETS.SEED_KEYWORDS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.SEED_KEYWORDS);
    sheet.getRange(1, 1).setValue('keyword');
    sheet.setFrozenRows(1);
    var initRows = DEFAULT_SEED_KEYWORDS.map(function (k) { return [k]; });
    sheet.getRange(2, 1, initRows.length, 1).setValues(initRows);
    return DEFAULT_SEED_KEYWORDS;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    var fillRows = DEFAULT_SEED_KEYWORDS.map(function (k) { return [k]; });
    sheet.getRange(2, 1, fillRows.length, 1).setValues(fillRows);
    return DEFAULT_SEED_KEYWORDS;
  }
  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var keywords = values.map(function (r) { return String(r[0] || '').trim(); })
    .filter(function (k) { return k.length > 0; });
  if (!keywords.length) {
    var fallbackRows = DEFAULT_SEED_KEYWORDS.map(function (k) { return [k]; });
    sheet.getRange(2, 1, fallbackRows.length, 1).setValues(fallbackRows);
    return DEFAULT_SEED_KEYWORDS;
  }
  return keywords;
}
