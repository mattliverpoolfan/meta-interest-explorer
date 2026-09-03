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

var REFRESH_BATCH_SIZE = 40;

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
    finalizeRefresh_(state);
    props.deleteProperty('REFRESH_STATE');
    deleteRefreshTriggers_();
  } else {
    props.setProperty('REFRESH_STATE', JSON.stringify(state));
    scheduleNextBatch_();
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

  allInterests.forEach(function (row) {
    if (row.last_snapshot_id === state.snapshotId) {
      foundThisRunCount++;
      if (new Date(row.first_seen_at) >= new Date(state.startedAt)) newIds.push(row.id);
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
    status: 'done',
  });
}
