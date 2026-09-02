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

/** 對單一 pair 打三次 delivery_estimate：A 單獨、B 單獨、A∩B */
function computeOverlapForPair_(idA, idB) {
  var cached = getCachedOverlap_(idA, idB);
  if (cached) return cached;

  var sizeA = deliveryEstimate_([{ interests: [{ id: idA }] }]);
  Utilities.sleep(250);
  var sizeB = deliveryEstimate_([{ interests: [{ id: idB }] }]);
  Utilities.sleep(250);
  var sizeIntersection = deliveryEstimate_([{ interests: [{ id: idA }] }, { interests: [{ id: idB }] }]);

  var minSize = Math.min(sizeA, sizeB);
  var ratio = minSize > 0 ? sizeIntersection / minSize : 0;

  var row = {
    pair_key: pairKey_(idA, idB),
    interest_a: idA,
    interest_b: idB,
    size_a: sizeA,
    size_b: sizeB,
    size_intersection: sizeIntersection,
    overlap_ratio: Math.round(ratio * 10000) / 10000,
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
