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
  return finishPairOverlap_(idA, idB, sizeA, sizeB);
}

/**
 * 已經知道 A、B 各自的台灣規模時，只需要再打一次交集估算就能算出重疊率跟 lift。
 * 第三類掃描會先單獨查候選的規模來過濾，過濾通過才走到這一步，省掉重複查詢。
 */
function finishPairOverlap_(idA, idB, sizeA, sizeB) {
  Utilities.sleep(250);
  var sizeIntersection = deliveryEstimate_([{ interests: [{ id: idA }] }, { interests: [{ id: idB }] }]);

  var minSize = Math.min(sizeA, sizeB);
  // Meta 的 delivery_estimate 是抽樣估算，不是精確集合運算——兩個高度重疊（甚至幾乎同義）
  // 的標籤，交集偶爾會被估得比任一邊單獨的受眾還大。數學上交集不可能超過 min(A,B)，
  // 這裡直接夾住，避免顯示出「重疊率 535000%」這種明顯不合理的數字。
  var ratio = minSize > 0 ? Math.min(1, sizeIntersection / minSize) : 0;

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

var OVERLAP_SCAN_STATE_KEY = 'OVERLAP_SCAN_STATE';

// 2026-10-03 改版：原本是「挑 40 個候選全部丟進去比，比完才看結果」，比完才發現一堆數字不可靠
// （台灣規模貼著 Meta 回報下限、或標籤大到 lift 理論上不可能高），額度已經花掉了。
// 現在是「備選名單 + 比對前先過濾」：備選名單比目標多很多，比對每個候選之前先只查它的台灣
// 規模（1 次估算，快取起來全工具共用），不合規則的直接換下一個備選、不用花最貴的交集那一步，
// 直到湊滿 OVERLAP_ACCEPT_TARGET 個合格的或備選用完。
var OVERLAP_ACCEPT_TARGET = 40;
var OVERLAP_INDIRECT_QUOTA = 25; // ②間接相關最多佔這麼多，其餘名額留給隨機發現，避免被推理延伸全部佔滿
// 台灣規模下限：Meta 對極小受眾會直接貼著最低回報下限（約 1,000）回傳，這種規模算出的
// 100% 重疊與一模一樣的 lift 只是樣本雜訊，不是發現。
var MIN_TW_AUDIENCE_SIZE = 30000;
// 台灣規模上限（佔台灣總覆蓋人口的比例）：lift 的理論最大值 = 母體 ÷ 較大那一邊的規模，
// 標籤太大，就算兩邊完全重疊 lift 也不可能高（占 60% 人口的標籤，lift 最高只有約 1.7），
// 比出來只會是「標籤太大所以重疊率很高」的假象，不值得花額度。
var MAX_TW_AUDIENCE_SHARE = 0.25;
var OVERLAP_BATCH_MAX_EXAMINE = 30;
var OVERLAP_BATCH_TIME_BUDGET_MS = 150 * 1000;

function startOverlapScan_(seed, candidates, seedReason) {
  var state = {
    scanId: 'ovs_' + new Date().getTime(),
    seedId: seed.id,
    seedName: seed.name,
    seedReason: seedReason || '',
    candidates: candidates.map(function (c) { return [c.id, c.name, c.source || 'random']; }),
    cursor: 0,
    target: Math.min(OVERLAP_ACCEPT_TARGET, candidates.length),
    seedRange: null,
    accepted: { indirect: 0, random: 0 },
    skipped: { small: 0, large: 0, quota: 0 },
    results: [], // [id, name, 標籤端重疊率, lift, tw_size, source, 種子端重疊率, lift下緣, lift上緣]
  };
  PropertiesService.getScriptProperties().setProperty(OVERLAP_SCAN_STATE_KEY, JSON.stringify(state));
  scheduleOverlapScanBatch_();
  return {
    scanId: state.scanId,
    seedName: state.seedName,
    seedReason: state.seedReason,
    total: state.target,
    done: false,
    results: [],
  };
}

/** 規模是否值得拿去比對：回傳 'small' / 'large'（不值得）或 null（可以比）。 */
function screenCandidateSize_(size, totalPopulation) {
  if (size < MIN_TW_AUDIENCE_SIZE) return 'small';
  if (totalPopulation > 0 && size > totalPopulation * MAX_TW_AUDIENCE_SHARE) return 'large';
  return null;
}

/**
 * 一個候選標籤對種子的比對數字。Meta 給的每個人數都是範圍，所以 lift 同時算三個：
 * 中間值，以及最悲觀（交集取低、兩邊規模取高）、最樂觀（反過來）的情況。
 * 交集夾在「較小那邊的規模」以內——Meta 的估算偶爾會讓交集比單邊還大，數學上不可能。
 *   candSide：這個標籤的人，有幾成也在種子裡（投放時鎖定它，打到的人有多像種子）
 *   seedSide：種子裡有幾成也在這個標籤裡（用來理解受眾）
 */
function scanOverlapMetrics_(seedId, candId, seedRange, candRange, population) {
  var inter = deliveryEstimateRange_([{ interests: [{ id: seedId }] }, { interests: [{ id: candId }] }]);
  Utilities.sleep(250);
  var cap = Math.min(seedRange.mid, candRange.size);
  function clamp(v) { return Math.min(v, cap); }
  var iMid = clamp(inter.mid), iLo = clamp(inter.lower), iHi = clamp(inter.upper);
  function lift(i, sSize, cSize) {
    return (population > 0 && sSize > 0 && cSize > 0) ? i * population / (sSize * cSize) : 0;
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  return {
    candSide: candRange.size > 0 ? Math.round(Math.min(1, iMid / candRange.size) * 10000) / 10000 : 0,
    seedSide: seedRange.mid > 0 ? Math.round(Math.min(1, iMid / seedRange.mid) * 10000) / 10000 : 0,
    lift: r2(lift(iMid, seedRange.mid, candRange.size)),
    liftLow: r2(lift(iLo, seedRange.upper, candRange.upper)),
    liftHigh: r2(lift(iHi, seedRange.lower, candRange.lower)),
  };
}

function isScanFinished_(state) {
  return state.results.length >= state.target || state.cursor >= state.candidates.length;
}

/** 由時間觸發器呼叫，每次處理一批候選，沒跑完就排下一批 */
function runOverlapScanBatch() {
  var props = PropertiesService.getScriptProperties();
  var stateStr = props.getProperty(OVERLAP_SCAN_STATE_KEY);
  if (!stateStr) return; // 沒有進行中的掃描，可能被新搜尋蓋掉或手動清掉了
  var state = JSON.parse(stateStr);

  ensureOverlapCacheLiftColumn_();
  var totalPopulation = getTotalPopulationEstimate_();
  var twSizes = getTaiwanSizeMap_();
  var newSizes = [];
  var batchStart = new Date().getTime();
  var examined = 0;

  if (!state.seedRange) {
    state.seedRange = deliveryEstimateRange_([{ interests: [{ id: state.seedId }] }]);
    Utilities.sleep(250);
  }

  while (!isScanFinished_(state) &&
         examined < OVERLAP_BATCH_MAX_EXAMINE &&
         new Date().getTime() - batchStart < OVERLAP_BATCH_TIME_BUDGET_MS) {
    var candidate = state.candidates[state.cursor];
    state.cursor++;
    var candId = candidate[0];
    var candName = candidate[1];
    var source = candidate[2];

    if (source === 'indirect' && state.accepted.indirect >= OVERLAP_INDIRECT_QUOTA) {
      state.skipped.quota++;
      continue;
    }
    examined++;

    try {
      var size;
      var known = twSizes[String(candId)];
      if (known) {
        size = known.size;
      } else {
        var range = deliveryEstimateRange_([{ interests: [{ id: candId }] }]);
        size = range.mid;
        Utilities.sleep(250);
        // 0 可能是真的查無受眾，也可能是估算失敗（deliveryEstimateRange_ 失敗時回 0），
        // 不快取，免得把一次暫時性失敗永久記成「這個標籤沒人」。
        if (size > 0) {
          newSizes.push({ id: candId, tw_size: size, tw_lower: range.lower, tw_upper: range.upper });
          known = { size: size, lower: range.lower, upper: range.upper };
          twSizes[String(candId)] = known;
        }
      }

      var reject = size > 0 ? screenCandidateSize_(size, totalPopulation) : 'small';
      if (reject) {
        state.skipped[reject]++;
        continue;
      }

      var m = scanOverlapMetrics_(state.seedId, candId, state.seedRange, known, totalPopulation);
      state.results.push([candId, candName, m.candSide, m.lift, size, source, m.seedSide, m.liftLow, m.liftHigh]);
      state.accepted[source === 'indirect' ? 'indirect' : 'random']++;
    } catch (e) {
      Logger.log('重疊掃描候選「' + candName + '」失敗：' + e.message);
    }
  }

  saveTaiwanSizes_(newSizes);
  props.setProperty(OVERLAP_SCAN_STATE_KEY, JSON.stringify(state));

  if (isScanFinished_(state)) {
    deleteOverlapScanTriggers_();
  } else {
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
// lift = 1 代表跟純屬巧合一樣、沒有真實訊號；1.2 是行銷上常用的「指數 120」門檻，
// 中間值連這個都沒到的不顯示。只過濾顯示，不影響原始計算。
var MIN_DISPLAY_LIFT = 1.2;

function getOverlapScanStatus_(scanId) {
  var stateStr = PropertiesService.getScriptProperties().getProperty(OVERLAP_SCAN_STATE_KEY);
  if (!stateStr) return { running: false, replaced: true };
  var state = JSON.parse(stateStr);
  if (state.scanId !== scanId) return { running: false, replaced: true };

  var results = state.results.map(function (r) {
    return {
      id: r[0],
      name: r[1],
      cand_side: r[2],
      lift: r[3],
      tw_size: r[4],
      source: r[5],
      seed_side: r[6],
      lift_low: r[7],
      lift_high: r[8],
      strength: liftStrength_(r[3], r[7]),
    };
  }).filter(function (r) {
    return r.lift >= MIN_DISPLAY_LIFT;
  }).sort(function (a, b) { return b.lift - a.lift; });

  var skipped = state.skipped || { small: 0, large: 0, quota: 0 };
  return {
    running: !isScanFinished_(state),
    done: state.results.length,
    total: state.target,
    skipped: { small: skipped.small, large: skipped.large },
    seedName: state.seedName,
    seedReason: state.seedReason || '',
    results: results,
  };
}

/**
 * 分級看「最悲觀的 lift」（lift_low），因為 Meta 給的人數都是範圍，只靠中間值會把估算誤差
 * 當成訊號。門檻是慣例而非推導：行銷上常用的指數 120（＝lift 1.2）以上算明顯偏高；
 * 悲觀情況下仍有 2 倍以上，視為強訊號。
 *   strong    最悲觀的情況仍 ≥ 2 倍
 *   medium    最悲觀的情況仍 ≥ 1.2 倍
 *   uncertain 中間值有 ≥ 1.2 倍，但最悲觀情況不到——可能只是估算誤差
 */
function liftStrength_(lift, liftLow) {
  if (liftLow >= 2) return 'strong';
  if (liftLow >= 1.2) return 'medium';
  return 'uncertain';
}
