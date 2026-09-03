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
  // 科技與3C
  '手機', '筆記型電腦', '平板電腦', '智慧型手錶', '藍芽耳機', '遊戲主機', '相機', '空拍機',
  '智慧家庭', '電競', 'iPhone', 'Samsung', 'PlayStation', 'Nintendo Switch', 'Xbox',
  '電腦周邊', '機械鍵盤', '電競螢幕', '顯卡', '行動電源', '無線充電', 'NAS', '智慧音箱',
  // 美妝保養與時尚
  '保養品', '彩妝', '香水', '護膚', '美白', '抗老', '面膜', '精華液', '美甲', '美睫',
  '醫美', '微整形', '美妝', '時尚', '穿搭', '精品', '名牌包', '手錶', '珠寶', '球鞋',
  '潮流服飾', 'Zara', 'Uniqlo', 'Nike', 'Adidas', '快時尚', '口紅', '眼影', '防曬',
  '洗面乳', '卸妝', '頭皮護理', '香氛', '精油', '皮夾', '飾品', '洋裝', '西裝',
  // 運動休閒與健身
  '健身', '重訓', '瑜珈', '跑步', '馬拉松', '自行車', '游泳', '登山', '攀岩', '拳擊',
  '皮拉提斯', '高爾夫球', '網球', '籃球', '足球', '棒球', '羽球', '桌球', '排球',
  '滑雪', '衝浪', '潛水', '自由潛水', '溯溪', '露營', '徒步旅行', '運動內衣', '乳清蛋白',
  '運動營養品', '健身房', '肌力訓練', '有氧運動', '壺鈴', '筋膜槍',
  // 旅遊與住宿
  '旅遊', '自助旅行', '背包客', '訂房', '機票', '郵輪', '露營車', '國內旅遊', '日本旅遊',
  '歐洲旅遊', '韓國旅遊', '東南亞旅遊', '泰國旅遊', 'Airbnb', '飯店', '溫泉', '渡假村',
  '包車旅遊', '行李箱', '免稅店', '簽證', '打工度假',
  // 母嬰與親子
  '親子', '育兒', '懷孕', '母嬰用品', '尿布', '奶粉', '兒童玩具', '幼兒園', '兒童教育',
  '親子旅遊', '寶寶副食品', '嬰兒推車', '安全座椅', '月子中心', '產後護理', '童裝', '繪本',
  '產前檢查', '哺乳', '托嬰', '樂高', 'STEAM教育',
  // 遊戲與動漫娛樂
  '手機遊戲', '電玩', 'Steam', '任天堂', '桌遊', '卡牌遊戲', '英雄聯盟', '原神', '電影',
  '韓劇', '動漫', '音樂', 'Podcast', 'YouTube', 'Netflix', '演唱會', 'K-pop', 'J-pop',
  'Cosplay', '公仔', '模型', '劇本殺', '密室逃脫', 'PlayStation 5',
  // 投資理財與金融
  '投資', '理財', '股票', '基金', '保險', '信用卡', '加密貨幣', '比特幣', '以太坊',
  '房地產投資', '退休規劃', '記帳', 'ETF', '美股', '期貨', '外匯', '個人信貸', '房貸',
  '儲蓄險', '數位帳戶', '行動支付', '證券開戶',
  // 飲食美食與料理
  '美食', '咖啡', '甜點', '烘焙', '素食', '餐廳', '小吃', '精釀啤酒', '紅酒', '調酒',
  '料理', '食譜', '火鍋', '燒肉', '早午餐', '居酒屋', '下午茶', '氣炸鍋料理', '威士忌',
  '日本料理', '義大利麵', '拉麵', '健康餐盒', '手搖飲', '茶藝', '生酮飲食',
  // 居家生活與家電
  '居家裝潢', '家具', '家電', '收納', '園藝', 'DIY', '室內設計', '廚房用品', '空氣清淨機',
  '掃地機器人', '除濕機', '咖啡機', '淨水器', '床墊', '沙發', '系統櫃', '水電工程',
  '多肉植物', '智能家居', '寢具', '鍋具', '洗碗機',
  // 汽機車與交通
  '汽車', '機車', '電動車', '改裝車', 'Tesla', '重型機車', '自駕遊', '行車記錄器',
  '隔熱紙', '中古車', '輪胎', '洗車鍍膜', '露營拖車', 'SUV', '油電車',
  // 學習進修與職場
  '線上課程', '語言學習', '英文學習', '日文學習', '程式設計', '讀書會', '職涯發展',
  '證照考試', '轉職', '行銷企劃', '專案管理', '簡報技巧', '自我成長', 'MBA', '公職考試',
  // 健康醫療與保健
  '健康飲食', '減重', '睡眠', '心理健康', '中醫', '營養補充品', '益生菌', '膠原蛋白',
  '葉黃素', '魚油', '維他命', '視力保健', '牙齒矯正', '植牙', '戒菸', '健康檢查',
  // 寵物毛孩
  '寵物', '狗', '貓', '寵物用品', '寵物食品', '寵物美容', '水族', '貓砂', '飼料',
  '罐頭', '寵物推車', '寵物保險', '爬蟲類', '寵物訓練', '動物醫院',
  // 電商數位與B2B
  '電子商務', '開店平台', '跨境電商', '社群行銷', '短影音', '網紅行銷', '團購', '直播帶貨',
  'POS系統', '會員經營', 'SEO優化', 'Google廣告', 'Meta廣告', '品牌行銷',
  // 房地產與空間
  '房地產', '預售屋', '買房', '租屋', '系統家具', '衛浴改裝', '舊屋翻新', '驗屋', '搬家服務', '個人倉庫',
  // 專業服務與創業
  '法律諮詢', '會計師', '記帳士', '商標註冊', '企業貸款', '青年創業', '辦公室租賃',
  // 婚禮與節慶
  '婚紗攝影', '婚禮顧問', '喜餅', '新娘秘書', '婚宴會館', '蜜月旅行', '求婚戒',
  // 醫療美容與微整
  '眼鏡配鏡', '隱形眼鏡', '近視雷射', '皮秒雷射', '音波拉提', '玻尿酸', '肉毒桿菌', '除毛',
  // 生活風格與消費
  '二手車', '汽車保養', '車用配件', '機車改裝', '保溫瓶', '環保餐具', '手作甜點', '無包裝商店'

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
