/** 兩個興趣之間的重疊估算，結果快取進 OverlapCache 分頁 */

function pairKey_(idA, idB) {
  var pair = [String(idA), String(idB)].sort();
  return pair[0] + '_' + pair[1];
}

function getCachedOverlap_(idA, idB) {
  var ctx = indexSheetByKey_(SHEETS.OVERLAP_CACHE, 'pair_key');
  var entry = ctx.index[pairKey_(idA, idB)];
  return entry ? entry.data : null;
}

/**
 * 母體總覆蓋人數估算（拿掉所有興趣篩選的 delivery_estimate），拿來當 lift 的標準化基準。
 * 這是粗略常數用途，長期快取在 Script Property，不需要頻繁重算。
 */
function getTotalPopulationEstimate_() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('TOTAL_POPULATION_ESTIMATE');
  if (cached) return Number(cached);
  var total = deliveryEstimate_(undefined);
  if (total > 0) props.setProperty('TOTAL_POPULATION_ESTIMATE', String(total));
  return total;
}

/**
 * 舊的 OverlapCache 分頁是這次改動之前就存在的，表頭沒有 lift 欄位。
 * getSheet_ 只有在「建立新分頁」時才會寫表頭，既有分頁不會自動補上新欄位——
 * 如果不處理，upsertRows_ 照新版 SHEET_HEADERS 的欄位順序寫入時會把 lift 的值
 * 寫進物理上還是 computed_at 的那一格，資料會整個錯位。所以每次要動 OverlapCache
 * 之前，先確保表頭真的有 lift 這一欄，沒有就在 computed_at 前面插入一欄。
 */
function ensureOverlapCacheLiftColumn_() {
  var sheet = getSheet_(SHEETS.OVERLAP_CACHE);
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf('lift') !== -1) return;
  var computedAtCol = headers.indexOf('computed_at') + 1; // 1-based
  if (computedAtCol < 1) return;
  sheet.insertColumnBefore(computedAtCol);
  sheet.getRange(1, computedAtCol).setValue('lift');
}

/**
 * 對單一 pair 打三次 delivery_estimate：A 單獨、B 單獨、A∩B。
 * 同時算 overlap_ratio（交集/min(A,B)，偏袒受眾規模大的標籤，只適合單純顯示矩陣百分比）
 * 跟 lift（交集 ÷ (A規模×B規模÷母體總數)，排除掉規模偏誤，才是第三類真正要找的「意外關聯」訊號）。
 */
function computeOverlapForPair_(idA, idB) {
  ensureOverlapCacheLiftColumn_();
  var cached = getCachedOverlap_(idA, idB);
  if (cached) return cached;

  var sizeA = deliveryEstimate_([{ interests: [{ id: idA }] }]);
  Utilities.sleep(250);
  var sizeB = deliveryEstimate_([{ interests: [{ id: idB }] }]);
  Utilities.sleep(250);
  var sizeIntersection = deliveryEstimate_([{ interests: [{ id: idA }] }, { interests: [{ id: idB }] }]);

  var minSize = Math.min(sizeA, sizeB);
  var ratio = minSize > 0 ? sizeIntersection / minSize : 0;

  var totalPopulation = getTotalPopulationEstimate_();
  var expectedByChance = (totalPopulation > 0 && sizeA > 0 && sizeB > 0) ? (sizeA * sizeB / totalPopulation) : 0;
  var lift = expectedByChance > 0 ? sizeIntersection / expectedByChance : 0;

  var row = {
    pair_key: pairKey_(idA, idB),
    interest_a: idA,
    interest_b: idB,
    size_a: sizeA,
    size_b: sizeB,
    size_intersection: sizeIntersection,
    overlap_ratio: Math.round(ratio * 10000) / 10000,
    lift: Math.round(lift * 100) / 100,
    computed_at: new Date().toISOString(),
  };
  upsertRows_(SHEETS.OVERLAP_CACHE, 'pair_key', [row]);
  return row;
}

/** 每次請求最多算這麼多 pair，避免一次打爆 Meta API 額度或超過 Web App 的執行時間上限 */
var MAX_OVERLAP_PAIRS_PER_REQUEST = 15;

function estimateOverlapForPairs_(pairs) {
  if (pairs.length > MAX_OVERLAP_PAIRS_PER_REQUEST) {
    throw new Error('一次最多算 ' + MAX_OVERLAP_PAIRS_PER_REQUEST + ' 組配對，請減少工作清單裡的興趣數量');
  }
  return pairs.map(function (pair) {
    return computeOverlapForPair_(pair[0], pair[1]);
  });
}

// ── 第三類：種子 vs 候選池的非同步重疊掃描 ──────────────────────────────────
// 跟 Code.gs 裡快照刷新用的是同一套「批次 + Script Property 存狀態 + 觸發器接續」模式，
// 只是換一個獨立的 Property key（OVERLAP_SCAN_STATE）跟觸發器 handler
// （runOverlapScanBatch），不會跟快照刷新的 REFRESH_STATE/runRefreshBatch 互相干擾。
//
// 刻意不在啟動時同步跑第一批：直接/間接相關（第一二類）要快，如果被綁在同一次
// request 裡等重疊算完，反而拖慢使用者原本該秒回的結果。這裡只負責登記狀態、
// 排一個之後執行的觸發器，馬上把控制權還給呼叫端。
//
// Script Property 有 9KB 的單一值上限，candidates/results 用陣列 tuple（不是物件）
// 存，省掉重複的 key 名稊，40 筆候選也能穩穩存下。

var OVERLAP_SCAN_BATCH_SIZE = 6;
var OVERLAP_SCAN_STATE_KEY = 'OVERLAP_SCAN_STATE';

function startOverlapScan_(seed, candidates) {
  var state = {
    scanId: 'ovs_' + new Date().getTime(),
    seedId: seed.id,
    seedName: seed.name,
    candidates: candidates.map(function (c) { return [c.id, c.name]; }),
    cursor: 0,
    results: [], // [id, name, overlap_ratio, lift]
  };
  PropertiesService.getScriptProperties().setProperty(OVERLAP_SCAN_STATE_KEY, JSON.stringify(state));
  scheduleOverlapScanBatch_();
  return {
    scanId: state.scanId,
    seedName: state.seedName,
    total: state.candidates.length,
    done: false,
    results: [],
  };
}

/** 由時間觸發器呼叫，每次處理一批候選，沒跑完就排下一批 */
function runOverlapScanBatch() {
  var props = PropertiesService.getScriptProperties();
  var stateStr = props.getProperty(OVERLAP_SCAN_STATE_KEY);
  if (!stateStr) return; // 沒有進行中的掃描，可能被新搜尋蓋掉或手動清掉了
  var state = JSON.parse(stateStr);

  var batch = state.candidates.slice(state.cursor, state.cursor + OVERLAP_SCAN_BATCH_SIZE);
  batch.forEach(function (candidate) {
    try {
      var row = computeOverlapForPair_(state.seedId, candidate[0]);
      state.results.push([candidate[0], candidate[1], row.overlap_ratio, row.lift]);
    } catch (e) {
      Logger.log('重疊掃描候選「' + candidate[1] + '」失敗：' + e.message);
    }
  });

  state.cursor += OVERLAP_SCAN_BATCH_SIZE;
  var isDone = state.cursor >= state.candidates.length;

  if (isDone) {
    props.setProperty(OVERLAP_SCAN_STATE_KEY, JSON.stringify(state));
    deleteOverlapScanTriggers_();
  } else {
    props.setProperty(OVERLAP_SCAN_STATE_KEY, JSON.stringify(state));
    scheduleOverlapScanBatch_();
  }
}

function scheduleOverlapScanBatch_() {
  deleteOverlapScanTriggers_();
  ScriptApp.newTrigger('runOverlapScanBatch').timeBased().after(60 * 1000).create();
}

function deleteOverlapScanTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runOverlapScanBatch') ScriptApp.deleteTrigger(t);
  });
}

/**
 * scanId 對不上目前的全域狀態，代表被後發起的搜尋蓋掉了（單一全域掃描，
 * 小範圍分享情境下的已知取捨）——回傳 replaced:true，前端顯示「已被新的搜尋取代」
 * 而不是卡住轉圈。
 */
function getOverlapScanStatus_(scanId) {
  var stateStr = PropertiesService.getScriptProperties().getProperty(OVERLAP_SCAN_STATE_KEY);
  if (!stateStr) return { running: false, replaced: true };
  var state = JSON.parse(stateStr);
  if (state.scanId !== scanId) return { running: false, replaced: true };

  var results = state.results.map(function (r) {
    return { id: r[0], name: r[1], overlap_ratio: r[2], lift: r[3] };
  }).sort(function (a, b) { return b.lift - a.lift; });

  var done = state.cursor >= state.candidates.length;
  return {
    running: !done,
    done: state.results.length,
    total: state.candidates.length,
    seedName: state.seedName,
    results: results,
  };
}
