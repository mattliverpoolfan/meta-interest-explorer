/**
 * Meta Graph API 呼叫封裝。
 * 憑證一律從 Script Properties 讀，不寫死在程式碼、不進 git。
 *
 * 手動在「專案設定 > 指令碼屬性」填入下列 key（不要用 ui.prompt() 寫設定精靈：
 * Apps Script 單次執行的 6 分鐘上限含等待輸入的時間，序列跳好幾個輸入框很容易
 * 中途被系統砍掉、東西全部沒存到）：
 *   META_ACCESS_TOKEN     —— FAV/Freedom 帳戶的 access token（需有 ads_management 權限）
 *   META_AD_ACCOUNT_ID    —— act_xxxxxxxxx 格式，有沒有 act_ 前綴都可以
 *   META_API_VERSION      —— 選填，預設 v21.0
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

/**
 * 用關鍵字搜尋興趣。
 * isLiveQuery: true 時使用廣告帳戶專屬 targetingsearch（過濾後台不可投放標籤，單筆搜尋用）；
 * false 或未指定時使用 /search（批次掃描用，避免短時間大量請求撞到廣告帳戶的 80004 限速）。
 */
function searchAdInterest_(query, limit, isLiveQuery) {
  var config = getMetaConfig_();
  if (isLiveQuery) {
    var accountPath = '/act_' + config.accountId.replace(/^act_/, '');
    try {
      var json = metaGet_(accountPath + '/targetingsearch', { type: 'adinterest', q: query, locale: 'zh_TW', limit: limit || 50 });
      return filterToInterestClass_(json.data || []);
    } catch (e) {
      Logger.log('targetingsearch 失敗，退回 /search：' + e.message);
    }
  }
  var fallback = metaGet_('/search', { type: 'adinterest', q: query, locale: 'zh_TW', limit: limit || 200 });
  return filterToInterestClass_(fallback.data || []);
}

/**
 * 關鍵字沒有足夠精準匹配時，Meta 會用「行為」「人口統計資料」這類其他 class
 * 的熱門項目把結果補滿（例如搜「駱駝」會混進「新婚（不到一年）」）。
 * 每筆結果的 path[0] 就是所屬 class，只留 path[0] === '興趣' 的。
 */
function filterToInterestClass_(items) {
  return items.filter(function (item) {
    return item.path && item.path[0] === '興趣';
  });
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
  try {
    var json = metaGet_('/act_' + config.accountId.replace(/^act_/, '') + '/delivery_estimate', {
      optimization_goal: 'REACH',
      targeting_spec: JSON.stringify(targetingSpec),
    });
    var row = (json.data && json.data[0]) || {};
    // Meta 回傳的是 estimate_mau_lower_bound / estimate_mau_upper_bound 這組範圍，取平均當代表值
    // （estimate_dau 這個欄位雖然存在，但 REACH 這個 optimization_goal 底下它恆常是 0，不能拿來用）
    var lower = Number(row.estimate_mau_lower_bound || 0);
    var upper = Number(row.estimate_mau_upper_bound || lower);
    return (lower + upper) / 2 || lower || upper || 0;
  } catch (e) {
    Logger.log('delivery_estimate 估算失敗（可能含 Meta 已下架或不可投放的標籤）：' + e.message);
    return 0;
  }
}
