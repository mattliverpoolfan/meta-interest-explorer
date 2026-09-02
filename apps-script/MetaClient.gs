/**
 * Meta Graph API 呼叫封裝。
 * 憑證一律從 Script Properties 讀，不寫死在程式碼、不進 git。
 * 執行 setup() 一次即可（見本檔最下方），或手動在
 * 專案設定 > Script Properties 裡填入下列三個 key：
 *   META_ACCESS_TOKEN   —— FAV/Freedom 帳戶的 access token（需有 ads_management 權限）
 *   META_AD_ACCOUNT_ID  —— act_xxxxxxxxx 格式
 *   META_API_VERSION    —— 選填，預設 v21.0
 */

var META_BASE = 'https://graph.facebook.com';

function getMetaConfig_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('META_ACCESS_TOKEN');
  var accountId = props.getProperty('META_AD_ACCOUNT_ID');
  if (!token) throw new Error('缺少 Script Property: META_ACCESS_TOKEN');
  if (!accountId) throw new Error('缺少 Script Property: META_AD_ACCOUNT_ID');
  return {
    token: token,
    accountId: accountId,
    version: props.getProperty('META_API_VERSION') || 'v21.0',
    defaultCountry: props.getProperty('META_DEFAULT_COUNTRY') || 'TW',
  };
}

/** 設定精靈：在 Apps Script 編輯器裡選這個函式手動執行一次 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ui = SpreadsheetApp.getUi();
  var token = ui.prompt('貼上 Meta access token（需有 ads_management 權限）').getResponseText().trim();
  var accountId = ui.prompt('貼上廣告帳戶 ID（格式 act_xxxxxxxxx）').getResponseText().trim();
  var apiKey = ui.prompt('設定一組給 refreshSnapshot / estimateOverlap 用的 apiKey（自己取一串隨機字串）').getResponseText().trim();
  props.setProperties({
    META_ACCESS_TOKEN: token,
    META_AD_ACCOUNT_ID: accountId,
    APP_API_KEY: apiKey,
  });
  ui.alert('設定完成，已存進 Script Properties。');
}

function metaGet_(path, params) {
  var config = getMetaConfig_();
  var qs = Object.keys(params || {}).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var url = META_BASE + '/' + config.version + path + '?access_token=' + encodeURIComponent(config.token) + (qs ? '&' + qs : '');

  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = response.getResponseCode();
  var body = response.getContentText();
  var json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error('Meta API 回傳非 JSON（HTTP ' + code + '）：' + body.slice(0, 300));
  }
  if (json.error) {
    throw new Error('Meta API 錯誤：' + json.error.message + '（type=' + json.error.type + ', code=' + json.error.code + '）');
  }
  return json;
}

/** 用關鍵字搜尋興趣（type=adinterest） */
function searchAdInterest_(query, limit) {
  var json = metaGet_('/search', { type: 'adinterest', q: query, limit: limit || 200 });
  return json.data || [];
}

/** 給定興趣名稱清單，找 Meta 認為相關的其他興趣（type=adinterestsuggestion） */
function searchAdInterestSuggestion_(interestNames) {
  var json = metaGet_('/search', {
    type: 'adinterestsuggestion',
    interest_list: JSON.stringify(interestNames),
  });
  return json.data || [];
}

/** 抓興趣分類樹（type=adTargetingCategory&class=interests） */
function searchAdTargetingCategory_() {
  var json = metaGet_('/search', { type: 'adTargetingCategory', class: 'interests', limit: 5000 });
  return json.data || [];
}

/**
 * 觸及人數估算，用來算重疊。flexibleSpec 是 Graph API 的 flexible_spec 陣列：
 * 同一個 clause 裡的興趣是 OR，跨 clause 是 AND。
 * 例：[{interests:[{id:A}]}, {interests:[{id:B}]}] → A 交集 B
 *     [{interests:[{id:A},{id:B}]}]               → A 聯集 B
 */
function deliveryEstimate_(flexibleSpec) {
  var config = getMetaConfig_();
  var targetingSpec = {
    geo_locations: { countries: [config.defaultCountry] },
    flexible_spec: flexibleSpec,
  };
  var json = metaGet_('/act_' + config.accountId.replace(/^act_/, '') + '/delivery_estimate', {
    optimization_goal: 'REACH',
    targeting_spec: JSON.stringify(targetingSpec),
  });
  var row = (json.data && json.data[0]) || {};
  // Meta 回傳的是一個範圍，這裡取上下界平均當代表值
  var lower = Number(row.estimate_dau || row.users_lower_bound || 0);
  var upper = Number(row.estimate_mau || row.users_upper_bound || lower);
  return (lower + upper) / 2 || lower || upper || 0;
}
