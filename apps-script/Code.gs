/**
 * Web App 進入點（doGet / doPost）+ 批次刷新快照的排程邏輯。
 *
 * 部署方式：部署 > 新增部署作業 > 網頁應用程式，執行身分「我」，誰能存取先選「所有人」。
 * 第一次使用前，先在「專案設定 > 指令碼屬性」手動填入憑證跟 apiKey（見 MetaClient.gs 開頭說明）。
 */

// ── HTTP 進入點 ──────────────────────────────────────────────────────────

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'searchInterests') return jsonOutput_(handleSearchInterests_(e.parameter.q));
    if (action === 'categoryTree') return jsonOutput_(readSheetAsObjects_(SHEETS.CATEGORIES));
    if (action === 'suggestRelated') return jsonOutput_(handleSuggestRelated_(e.parameter.seed_ids, e.parameter.seed_names));
    if (action === 'refreshStatus') return jsonOutput_(getRefreshStatus_());
    return jsonOutput_({ error: '未知的 action：' + action });
  } catch (err) {
    return jsonOutput_({ error: err.message });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (body.action === 'estimateOverlap') {
      requireApiKey_(body.apiKey);
      return jsonOutput_({ results: estimateOverlapForPairs_(body.pairs || []) });
    }
    if (body.action === 'refreshSnapshot') {
      requireApiKey_(body.apiKey);
      startOrContinueRefresh_();
      return jsonOutput_({ status: 'started_or_continuing' });
    }
    return jsonOutput_({ error: '未知的 action：' + body.action });
  } catch (err) {
    return jsonOutput_({ error: err.message });
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function requireApiKey_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty('APP_API_KEY');
  if (!expected) throw new Error('尚未設定 APP_API_KEY，請到「專案設定 > 指令碼屬性」新增');
  if (key !== expected) throw new Error('apiKey 不正確');
}

// ── 唯讀端點的實作 ────────────────────────────────────────────────────────

function handleSearchInterests_(q) {
  if (!q) return [];
  var query = String(q).toLowerCase();
  var cached = readSheetAsObjects_(SHEETS.INTERESTS).filter(function (row) {
    return String(row.name).toLowerCase().indexOf(query) !== -1;
  });
  if (cached.length) return cached;
  // 快取沒有才即時查 Meta；刻意不寫回 Interests 分頁，避免污染快照的 last_snapshot_id 語意
  return searchAdInterest_(q, 50);
}

/**
 * Meta 的 adinterestsuggestion 吃的是興趣「名稱」不是 ID。前端手上本來就有名稱
 * （搜尋結果裡就帶著），所以優先直接用 seed_names；沒帶名稱時才退回拿 ID 去
 * Interests 分頁反查——注意還沒跑過刷新快照時那張分頁是空的，只靠反查會失敗。
 */
function handleSuggestRelated_(seedIdsParam, seedNamesParam) {
  var names = String(seedNamesParam || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });

  if (!names.length) {
    var seedIds = String(seedIdsParam || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    if (!seedIds.length) return [];
    var interestsIndex = indexSheetByKey_(SHEETS.INTERESTS, 'id').index;
    names = seedIds.map(function (id) {
      var row = interestsIndex[id];
      return row ? row.data.name : null;
    }).filter(function (n) { return n; });
  }
  if (!names.length) throw new Error('找不到興趣名稱，無法查詢相關興趣');

  // 用名稱當快取 key，因為名稱才是真正丟給 Meta 的東西
  var cacheKey = names.slice().sort().join(',');
  var cacheCtx = indexSheetByKey_(SHEETS.RELATED_CACHE, 'seed_interest_id');
  var cached = cacheCtx.index[cacheKey];
  if (cached) return JSON.parse(cached.data.related_json);

  var suggestions = searchAdInterestSuggestion_(names);
  upsertRows_(SHEETS.RELATED_CACHE, 'seed_interest_id', [{
    seed_interest_id: cacheKey,
    related_json: JSON.stringify(suggestions),
    computed_at: new Date().toISOString(),
  }]);
  return suggestions;
}

function getRefreshStatus_() {
  var stateStr = PropertiesService.getScriptProperties().getProperty('REFRESH_STATE');
  if (!stateStr) return { running: false };
  var state = JSON.parse(stateStr);
  return { running: true, progress: state.cursor + '/' + state.keywords.length, snapshotId: state.snapshotId };
}

// ── 批次刷新快照 ──────────────────────────────────────────────────────────
// Apps Script 單次執行上限 6 分鐘，關鍵字一多跑不完，所以拆成多個批次，
// 每批跑完自己排一個 1 分鐘後的觸發器接著跑下一批，直到全部關鍵字處理完。

var REFRESH_BATCH_SIZE = 200;

/**
 * 供在 Apps Script 編輯器中手動點選「▶ 執行」的進入點。
 * 沒有底線結尾才會出現在頂部函式下拉選單中。
 */
function startRefresh() {
  startOrContinueRefresh_();
}

/**
 * 自動為本專案設定定期更新排程觸發器（每週一凌晨 02:00 自動執行 startRefresh）。
 * 會自動清理多餘或手動殘留的舊觸發器，確保專案乾淨且不重複建立。
 */
function setupAutoSchedule() {
  var triggers = ScriptApp.getProjectTriggers();
  var weeklyTriggerExists = false;

  triggers.forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runRefreshBatch') {
      ScriptApp.deleteTrigger(t);
      Logger.log('已自動清理舊的 runRefreshBatch 觸發器');
    } else if (fn === 'startRefresh') {
      weeklyTriggerExists = true;
    }
  });

  if (!weeklyTriggerExists) {
    ScriptApp.newTrigger('startRefresh')
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(2)
      .create();
    Logger.log('✅ 已成功自動建立每週一凌晨 02:00 定期更新快照的排程觸發器！');
  } else {
    Logger.log('ℹ️ 定期更新排程觸發器（startRefresh）已存在，無需重複建立。');
  }
}

/**
 * 快速測試權限、Script Properties、種子關鍵字讀取，並自動設定定期排程觸發器。
 */
function testPermissionsAndKeywords() {
  Logger.log('=== 檢查 Script Properties ===');
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('META_ACCESS_TOKEN');
  var accountId = props.getProperty('META_AD_ACCOUNT_ID');
  var apiKey = props.getProperty('APP_API_KEY');
  Logger.log('META_ACCESS_TOKEN: ' + (token ? '已設定 (前5碼 ' + token.slice(0, 5) + '...)' : '未設定'));
  Logger.log('META_AD_ACCOUNT_ID: ' + accountId);
  Logger.log('APP_API_KEY: ' + (apiKey ? '已設定' : '未設定'));
  if (props.getProperty('SEED_KEYWORDS_SHEET_ID')) {
    props.deleteProperty('SEED_KEYWORDS_SHEET_ID');
    Logger.log('已自動清除舊的 SEED_KEYWORDS_SHEET_ID 屬性（已整合回本試算表）');
  }

  Logger.log('=== 檢查種子關鍵字（本資料庫 SeedKeywords 分頁）===');
  var keywords = getSeedKeywords_();
  Logger.log('成功讀取關鍵字數量: ' + keywords.length);
  if (keywords.length > 0) {
    Logger.log('前 5 個關鍵字範例: ' + keywords.slice(0, 5).join(', '));
  } else {
    Logger.log('警告: 未能讀取到關鍵字');
  }

  Logger.log('=== 自動設定定期排程觸發器 ===');
  setupAutoSchedule();
}

function startOrContinueRefresh_() {
  var props = PropertiesService.getScriptProperties();
  var stateStr = props.getProperty('REFRESH_STATE');
  if (!stateStr) {
    var keywords = getSeedKeywords_();
    if (!keywords.length) throw new Error('SeedKeywords 分頁是空的，請先加幾個關鍵字再刷新');
    var state = {
      snapshotId: 'snap_' + new Date().getTime(),
      prevSnapshotId: getLatestSnapshotId_(),
      startedAt: new Date().toISOString(),
      keywords: keywords,
      cursor: 0,
      categoriesDone: false,
    };
    props.setProperty('REFRESH_STATE', JSON.stringify(state));
  }
  runRefreshBatch();
}

function getLatestSnapshotId_() {
  var rows = readSheetAsObjects_(SHEETS.SNAPSHOTS);
  return rows.length ? rows[rows.length - 1].snapshot_id : null;
}

/** 由 startOrContinueRefresh_ 直接呼叫第一批，之後每批由時間觸發器呼叫接續 */
function runRefreshBatch() {
  var props = PropertiesService.getScriptProperties();
  var stateStr = props.getProperty('REFRESH_STATE');
  if (!stateStr) return; // 沒有進行中的刷新，可能是被手動清掉了
  var state = JSON.parse(stateStr);

  if (!state.categoriesDone) {
    refreshCategoryTree_();
    state.categoriesDone = true;
  }

  var batch = state.keywords.slice(state.cursor, state.cursor + REFRESH_BATCH_SIZE);
  var found = [];
  batch.forEach(function (keyword) {
    try {
      searchAdInterest_(keyword).forEach(function (r) { found.push(r); });
    } catch (e) {
      Logger.log('關鍵字「' + keyword + '」查詢失敗：' + e.message);
    }
    Utilities.sleep(200);
  });

  upsertFoundInterests_(found, state.snapshotId);

  state.cursor += REFRESH_BATCH_SIZE;
  var isDone = state.cursor >= state.keywords.length;

  if (isDone) {
    // 方案 B：自動關聯拓圈（Recursive Expansion）
    expandRelatedSuggestions_(state);
    finalizeRefresh_(state);
    props.deleteProperty('REFRESH_STATE');
    deleteRefreshTriggers_();
  } else {
    props.setProperty('REFRESH_STATE', JSON.stringify(state));
    scheduleNextBatch_();
  }
}

/** 方案 B：自動抽取當前熱門標籤，向 Meta 要求官方關聯建議，自動拓圈 500~1500 筆長尾受眾 */
function expandRelatedSuggestions_(state) {
  try {
    var all = readSheetAsObjects_(SHEETS.INTERESTS);
    var sampleNames = [];
    for (var i = 0; i < all.length && sampleNames.length < 30; i++) {
      if (all[i].name && sampleNames.indexOf(all[i].name) === -1) {
        sampleNames.push(all[i].name);
      }
    }
    if (sampleNames.length) {
      Logger.log('正在執行方案 B 自動關聯拓圈，選取代表詞：' + sampleNames.slice(0, 5).join(', '));
      for (var j = 0; j < sampleNames.length; j += 5) {
        var chunk = sampleNames.slice(j, j + 5);
        try {
          var res = searchAdInterestSuggestion_(chunk);
          if (res && res.length) {
            upsertFoundInterests_(res, state.snapshotId);
          }
        } catch (e) {
          Logger.log('關聯推薦跳過：' + e.message);
        }
        Utilities.sleep(200);
      }
    }
  } catch (e) {
    Logger.log('關聯拓圈異常：' + e.message);
  }
}

function refreshCategoryTree_() {
  try {
    var categories = searchAdTargetingCategory_();
    var now = new Date().toISOString();
    upsertRows_(SHEETS.CATEGORIES, 'id', categories.map(function (c) {
      return {
        id: c.id,
        name: c.name,
        path: JSON.stringify(c.path || []),
        audience_size_lower_bound: c.audience_size_lower_bound || '',
        audience_size_upper_bound: c.audience_size_upper_bound || '',
        last_seen_at: now,
      };
    }));
  } catch (e) {
    // 分類樹抓失敗不影響興趣搜尋本身，記錄下來但繼續跑批次
    Logger.log('抓分類樹失敗：' + e.message);
  }
}

function upsertFoundInterests_(found, snapshotId) {
  if (!found.length) return;
  var now = new Date().toISOString();
  var existingIndex = indexSheetByKey_(SHEETS.INTERESTS, 'id').index;
  var seen = {};
  var rows = [];
  found.forEach(function (item) {
    if (seen[item.id]) return;
    seen[item.id] = true;
    var existing = existingIndex[String(item.id)];
    rows.push({
      id: item.id,
      name: item.name,
      path: JSON.stringify(item.path || []),
      audience_size_lower_bound: item.audience_size_lower_bound || '',
      audience_size_upper_bound: item.audience_size_upper_bound || '',
      topic: item.topic || '',
      description: item.description || '',
      first_seen_at: existing ? existing.data.first_seen_at : now,
      last_seen_at: now,
      last_snapshot_id: snapshotId,
    });
  });
  upsertRows_(SHEETS.INTERESTS, 'id', rows);
}

function scheduleNextBatch_() {
  deleteRefreshTriggers_();
  ScriptApp.newTrigger('runRefreshBatch').timeBased().after(60 * 1000).create();
}

function deleteRefreshTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRefreshBatch') ScriptApp.deleteTrigger(t);
  });
}

/** 這次跑完後：diff 出新出現/消失的興趣，寫一列到 Snapshots */
function finalizeRefresh_(state) {
  var allInterests = readSheetAsObjects_(SHEETS.INTERESTS);
  var newIds = [];
  var removedIds = [];
  var foundThisRunCount = 0;
  var isBaseline = !state.prevSnapshotId;

  allInterests.forEach(function (row) {
    if (row.last_snapshot_id === state.snapshotId) {
      foundThisRunCount++;
      // 只有在非初次基準建立時，才記錄 new_interest_ids；初次建庫為 baseline
      if (!isBaseline && new Date(row.first_seen_at) >= new Date(state.startedAt)) {
        newIds.push(row.id);
      }
    } else if (state.prevSnapshotId && row.last_snapshot_id === state.prevSnapshotId) {
      // 上一份快照有出現，這次完全沒被更新到 → 消失了
      removedIds.push(row.id);
    }
  });

  appendRow_(SHEETS.SNAPSHOTS, {
    snapshot_id: state.snapshotId,
    started_at: state.startedAt,
    finished_at: new Date().toISOString(),
    keywords_used_count: state.keywords.length,
    interests_found_count: foundThisRunCount,
    new_interest_ids: JSON.stringify(newIds),
    removed_interest_ids: JSON.stringify(removedIds),
    status: isBaseline ? 'baseline_done' : 'done',
  });
}
