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
    if (action === 'overlapScanStatus') return jsonOutput_(getOverlapScanStatus_(e.parameter.scanId));
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
    if (body.action === 'unifiedSearch') {
      requireApiKey_(body.apiKey);
      return jsonOutput_(handleUnifiedSearch_(body.query));
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

// 2026-09-27 修正：使用者要的是「這裡看到的建議，要跟親自去廣告後台搜尋完全一致」。
// 本地快取只是先前批次掃描留下的不完整快照，「快取只要有一筆結果就整個跳過即時查詢」
// 這個舊邏輯會讓 Meta 上真實存在、但快取沒收錄到的相關標籤被完全遮蔽——例如中文
// 「瑜珈」／「瑜伽」這種常見的同義寫法，快取剛好只收錄其中一種寫法的標籤，就會讓
// 另一種寫法（例如「訶陀瑜伽」）永遠不會被看到，即使 Meta 真的查得到。改成一律
// 即時查 Meta，才能保證使用者在這裡打字看到的，就是真的去廣告後台搜同一個字會看到
// 的東西——代價是每次查詢都要真的打一次 Meta API，會比查本地快取慢（實測約 2~4 秒）。
function handleSearchInterests_(q) {
  if (!q) return [];
  var results = searchAdInterest_(q, 50, true);
  recordLiveInterestSightings_(results);
  return results;
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
//
// 2026-09-28 修正：原本設 200，實測跑系統性擴散（一次要處理幾千個詞）時，
// 執行紀錄裡真的出現「逾時」——某一批跑了 360.68 秒，正好卡在 6 分鐘的硬上限被
// 強制中斷，連續幾次之後 Google 直接把整個排程觸發器自動停用。跟 Meta 的額度
// 無關，純粹是這個數字設太大，遇到網路稍慢就會超過上限。改成 80 之後隔天又遇到
// 一次同樣的逾時（80 筆這次跑了 360.7 秒，平均每筆 4.5 秒，遠高於原本實測的
// 1.2~1.3 秒）——代表 Meta 單次查詢的耗時本身會波動，光憑「固定筆數」去猜一個
// 安全值靠不住，同一個數字換一個時段跑就可能又超過。
//
// 2026-09-29 修正：改成直接量時間，不用猜筆數。REFRESH_BATCH_SIZE 只當作「軟
// 上限」（就算時間還很充裕，一批最多還是不超過這個筆數），真正的安全機制是
// REFRESH_BATCH_TIME_BUDGET_MS——批次執行中持續檢查已經花了多久，一旦逼近這個
// 時間就提前結束這一批（剩下的留給下一批接著處理，state.cursor 只會前進到真正
// 處理完的筆數，不會漏掉任何詞），不管當下 Meta 回應快或慢都不會撞到 6 分鐘上限。
var REFRESH_BATCH_SIZE = 80;
var REFRESH_BATCH_TIME_BUDGET_MS = 4 * 60 * 1000;

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
    var seedKeywords = getSeedKeywords_();
    if (!seedKeywords.length) throw new Error('SeedKeywords 分頁是空的，請先加幾個關鍵字再刷新');

    // 2026-09-28 修正：Meta 自己有一份官方興趣分類清單（type=adTargetingCategory,
    // class=interests），回傳的資料結構跟 Interests 分頁存的標籤完全一樣（同樣是
    // 「興趣」class，同樣有 id、受眾規模），是真的可以直接拿去投放的標籤，不是只能
    // 拿去釣魚用的搜尋詞——原本這份清單只寫進獨立的 Categories 分頁（給分類瀏覽
    // 用），從來沒有併進 Interests。這裡先併進去，讓下面組搜尋詞時能一併把分類
    // 名稱當種子用。抓分類清單失敗不影響原本用關鍵字掃描的部分，照樣繼續跑。
    try {
      upsertFoundInterests_(searchAdTargetingCategory_(), 'category_tree');
    } catch (e) {
      Logger.log('抓 Meta 官方分類清單失敗，這次刷新略過分類補充：' + e.message);
    }

    var state = {
      snapshotId: 'snap_' + new Date().getTime(),
      prevSnapshotId: getLatestSnapshotId_(),
      startedAt: new Date().toISOString(),
      keywords: buildUnsearchedCandidates_(seedKeywords),
      cursor: 0,
      categoriesDone: false,
    };
    props.setProperty('REFRESH_STATE', JSON.stringify(state));
  }
  runRefreshBatch();
}

/**
 * 2026-09-28 新增：組出「真的還沒被拿去搜過」的搜尋詞——來源是 extraTerms（種子關鍵字，
 * 或空陣列）加上資料庫目前所有標籤自己的名字，扣掉 SearchedTerms 分頁裡已經記錄過的。
 * 這是「系統性擴散」的核心：資料庫裡的標籤名字本身也拿去再搜一次，找它們的鄰居，
 * 但已經搜過的詞永遠不會被重複搜，保證每一輪都在真正往外擴張，而不是原地打轉。
 */
function buildUnsearchedCandidates_(extraTerms) {
  var searched = getSearchedTermsSet_();
  var allNames = readSheetAsObjects_(SHEETS.INTERESTS).map(function (r) { return r.name; });
  var candidates = dedupeStrings_((extraTerms || []).concat(allNames));
  return candidates.filter(function (t) { return !searched[t]; });
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

  // 2026-09-28 新增：Meta 每次回應都會附帶這個 App 目前用掉多少額度百分比的標頭
  // （實測過，見 CLAUDE.md），批次掃描前先看一下，真的偏高就延後 30 分鐘再試，
  // 不要等到被 Meta 擋掉才知道。目前實測遠低於門檻，正常情況不會走到這個分支。
  if (shouldPauseForMetaUsage_()) {
    Logger.log('Meta 應用程式額度使用率偏高，延後 30 分鐘後再繼續這批（狀態、進度都保留）。');
    scheduleNextBatch_(30);
    return;
  }

  if (!state.categoriesDone) {
    refreshCategoryTree_();
    state.categoriesDone = true;
  }

  var batchStartTime = new Date().getTime();
  var endIndex = Math.min(state.cursor + REFRESH_BATCH_SIZE, state.keywords.length);
  var found = [];
  var processedTerms = [];
  for (var i = state.cursor; i < endIndex; i++) {
    if (new Date().getTime() - batchStartTime > REFRESH_BATCH_TIME_BUDGET_MS) {
      Logger.log('這批已經逼近安全時間上限，提前結束（這批實際處理了 ' + processedTerms.length +
        ' 筆），剩下的留給下一批繼續。');
      break;
    }
    var keyword = state.keywords[i];
    try {
      searchAdInterest_(keyword, 200, false).forEach(function (r) { found.push(r); });
    } catch (e) {
      Logger.log('關鍵字「' + keyword + '」查詢失敗：' + e.message);
    }
    processedTerms.push(keyword);
    Utilities.sleep(200);
  }

  upsertFoundInterests_(found, state.snapshotId);
  recordSearchedTerms_(processedTerms);

  state.cursor += processedTerms.length;

  if (state.cursor >= state.keywords.length) {
    // 2026-09-28 修正：原本這裡就直接收尾，換成先檢查資料庫裡是不是又多了「還沒
    // 被拿去搜過」的新標籤名字（這一批剛找到的、或更早之前找到但還沒輪到的）——
    // 有的話代表還沒搜到飽和，接到隊伍後面繼續搜下一輪；完全沒有新的可搜，才是
    // 真的搜到飽和，這時候才真正收尾。這個迴圈本身就是「系統性擴散」的完整實作，
    // 取代原本依賴已失效 adinterestsuggestion API 的方案 B。
    var moreCandidates = buildUnsearchedCandidates_([]);
    if (moreCandidates.length) {
      Logger.log('這一輪搜完又找到 ' + moreCandidates.length + ' 個還沒搜過的新標籤，繼續下一輪。');
      state.keywords = state.keywords.concat(moreCandidates);
      props.setProperty('REFRESH_STATE', JSON.stringify(state));
      scheduleNextBatch_();
      return;
    }
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

/**
 * 2026-09-28 新增：平常使用者查詢時，即時查到的標籤原本用完就丟，沒有存回資料庫。
 * 讓每次即時查詢順便把查到的結果回填，資料庫會隨著大家實際在查的東西自然變大，
 * 不用等每週排程的批次掃描，而且會朝著「使用者真正在意的方向」成長，不是朝著
 * 種子關鍵字清單猜的方向。用 'live_query' 當 snapshotId 標記來源，跟批次掃描的
 * snap_xxx 區分開來。寫入失敗不影響本次查詢結果本身（try/catch 吞掉）。
 */
function recordLiveInterestSightings_(items) {
  if (!items || !items.length) return;
  try {
    upsertFoundInterests_(items, 'live_query');
  } catch (e) {
    Logger.log('即時查詢結果回填資料庫失敗（不影響本次查詢結果）：' + e.message);
  }
}

/** delayMinutes 省略時預設 1 分鐘（正常批次間隔）；額度偏高時會傳更長的延遲。 */
function scheduleNextBatch_(delayMinutes) {
  deleteRefreshTriggers_();
  ScriptApp.newTrigger('runRefreshBatch').timeBased().after((delayMinutes || 1) * 60 * 1000).create();
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
