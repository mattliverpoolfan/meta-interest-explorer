/**
 * 一次搜尋、三類結果同時呈現的主要進入點：
 *   1. 直接相關 —— 原始字詞 + Gemini 聯想的同義詞，逐一送進 Meta 驗證存在
 *   2. 邏輯上間接相關 —— Gemini 推理受眾輪廓後聯想的詞，一樣要 Meta 驗證存在，
 *      再依關聯強度分三級（高/中/推測性）
 *   3. 受眾重疊比對 —— 挑一個種子標籤，跟候選池逐一算重疊，非同步跑（見 Overlap.gs）
 *
 * 前兩類只查候選詞、不查候選詞的候選詞，全程同步在一次 request 內跑完，
 * 所以「快」；第三類另外交給批次＋觸發器的非同步機制，這裡只負責啟動它。
 */

var UNIFIED_SEARCH_TERM_DELAY_MS = 100;
var UNIFIED_SEARCH_RESULT_LIMIT = 20;
var CLASSIFY_INPUT_LIMIT = 60;
var OVERLAP_CANDIDATE_POOL_LIMIT = 40;
var OVERLAP_CANDIDATE_RANDOM_SAMPLE = 30;

function handleUnifiedSearch_(query) {
  query = String(query || '').trim();
  if (!query) throw new Error('請輸入搜尋字詞');

  var gemini = classifyInterestCandidates_(query);
  var allTerms = dedupeStrings_([query].concat(gemini.direct || []).concat(gemini.indirect || []));

  // 直接用一份合併後的搜尋詞去查、去重，分類完全交給下一步統一判斷——
  // 不能用「這個詞原本被 AI 歸在哪一類」來決定結果的分類，那正是誤殺/漏網的來源
  // （Meta 對查無精準匹配的字詞常補位不相關的熱門標籤，即使搜尋詞本身看似「直接」）。
  var verified = verifyTermsAgainstMeta_(allTerms);
  var forClassify = verified.slice(0, CLASSIFY_INPUT_LIMIT);
  var classifications = classifyAndTierResults_(query, forClassify.map(function (e) {
    return { term: e.term, name: e.item.name };
  }));

  var aiClassificationFailed = classifications.length > 0 && classifications.every(function (c) { return c.aiFailed; });

  var directResults = [];
  var indirectByTier = { 1: [], 2: [], 3: [] };
  forClassify.forEach(function (entry, i) {
    var c = classifications[i] || { bucket: 'direct', tier: 0, closeness: 0 };
    if (c.bucket === 'unrelated') return;
    if (c.bucket === 'indirect') {
      var tier = (c.tier === 1 || c.tier === 2 || c.tier === 3) ? c.tier : 2;
      indirectByTier[tier].push(entry.item);
    } else {
      // closeness 掛在標籤物件上，只給 pickSeed_ 挑種子用，不是要顯示給使用者看的欄位。
      entry.item.closeness = (typeof c.closeness === 'number') ? c.closeness : null;
      directResults.push(entry.item);
    }
  });

  directResults = directResults.slice(0, UNIFIED_SEARCH_RESULT_LIMIT);
  var indirectResults = {
    high: indirectByTier[1].slice(0, UNIFIED_SEARCH_RESULT_LIMIT),
    medium: indirectByTier[2].slice(0, UNIFIED_SEARCH_RESULT_LIMIT),
    speculative: indirectByTier[3].slice(0, UNIFIED_SEARCH_RESULT_LIMIT),
  };

  var overlapScan = null;
  var picked = pickSeed_(query, directResults);
  if (picked) {
    var allIndirectFlat = indirectResults.high.concat(indirectResults.medium, indirectResults.speculative);
    var candidatePool = buildCandidatePool_(picked.item, directResults, allIndirectFlat);
    if (candidatePool.length) {
      overlapScan = startOverlapScan_(picked.item, candidatePool, picked.reason);
    }
  }

  return {
    direct: directResults,
    indirect: indirectResults,
    overlapScan: overlapScan,
    aiClassificationFailed: aiClassificationFailed,
  };
}

function dedupeStrings_(list) {
  var seen = {};
  var out = [];
  list.forEach(function (s) {
    var t = String(s || '').trim();
    if (!t || seen[t]) return;
    seen[t] = true;
    out.push(t);
  });
  return out;
}

/**
 * 每個候選詞都是「搜尋詞」不是「答案」，逐一驗證是否真的存在，回傳 {item, term}。
 * 先查快取（`searchCachedInterests_`）、有結果就不打即時 API——快取是先前批次掃描
 * 已經驗證過的真實標籤；只有快取查無任何結果時才退回即時查詢，Meta 的即時
 * targetingsearch 查無精準匹配時會補位不相關的熱門標籤，但這裡不需要處理，
 * 交給後面統一的 classifyAndTierResults_ 判斷去留。
 */
function verifyTermsAgainstMeta_(terms) {
  var seen = {};
  var out = [];
  terms.forEach(function (term, index) {
    if (index > 0) Utilities.sleep(UNIFIED_SEARCH_TERM_DELAY_MS);
    try {
      var results = searchCachedInterests_(term);
      if (!results.length) results = searchAdInterest_(term, 20, true);
      results.forEach(function (item) {
        var id = String(item.id);
        if (seen[id]) return;
        seen[id] = true;
        out.push({ item: item, term: term });
      });
    } catch (e) {
      Logger.log('候選詞「' + term + '」查詢失敗：' + e.message);
    }
  });
  return out;
}

/**
 * 種子：直接相關裡跟原始字詞完全同名的優先——這種情況下拿使用者自己輸入的詞當種子最準確，
 * 不需要任何猜測。
 *
 * 沒有精準對應時，改成挑 AI 判斷「跟原始搜尋詞語意最接近」的那一筆（見 GeminiClient.gs 的
 * closeness 欄位，例如搜「慢跑鞋」查無此標籤時，closeness 最高的應該是「慢跑」這種幾乎同義
 * 的活動本身，而不是「跑步機」這種同領域但明顯是別的東西的標籤）——不是用受眾規模來挑。
 * 早期版本用過「受眾規模最小」的heuristic，問題是規模小不等於語意接近，兩者沒有必然關係，
 * 也曾經誤打誤撞挑到不相關的冷門標籤當種子（見 CLAUDE.md「已知限制」）。
 *
 * 只有在完全沒有 closeness 資料時（理論上只會發生在 AI 分類這一步整個失敗、退回保守 fallback
 * 的情況——那種情況下 directResults 通常只剩下精準同名這一筆，已經被上面的 exact 分支處理掉，
 * 這裡走不到）才退回舊的「受眾規模最小」heuristic 當最後防線，不會完全沒有種子可選。
 *
 * 回傳 {item, reason}，reason 是給使用者看的一句話，說明這次為什麼挑這個當種子——選種子的
 * 邏輯常常就是受眾重疊比對結果落差的原因，所以特別交代清楚，不要讓使用者猜。
 */
function pickSeed_(query, directResults) {
  if (!directResults.length) return null;
  var exact = directResults.filter(function (item) { return item.name === query; });
  if (exact.length) {
    return { item: exact[0], reason: '與搜尋詞完全相符' };
  }

  var byCloseness = directResults.filter(function (item) { return typeof item.closeness === 'number'; });
  if (byCloseness.length) {
    byCloseness.sort(function (a, b) { return b.closeness - a.closeness; });
    return { item: byCloseness[0], reason: '沒有完全同名的標籤，AI 判斷這是語意上最接近搜尋詞的直接相關標籤' };
  }

  var bySize = directResults.map(function (item) {
    var lower = Number(item.audience_size_lower_bound) || 0;
    var upper = Number(item.audience_size_upper_bound) || lower;
    var size = (lower + upper) / 2;
    return { item: item, size: size > 0 ? size : Infinity };
  });
  bySize.sort(function (a, b) { return a.size - b.size; });
  return { item: bySize[0].item, reason: 'AI 關聯性複查暫時無法使用，退回選受眾規模最小的直接相關標籤當種子' };
}

/**
 * 候選池 = 直接相關（扣掉種子）+ 間接相關 + 從已知標籤庫隨機取樣一批，
 * 隨機取樣是刻意留給「使用者跟 AI 都想不到，但受眾真的重疊」的空間——這正是第三類存在的意義。
 */
function buildCandidatePool_(seed, directResults, indirectResults) {
  var seenIds = {};
  seenIds[String(seed.id)] = true;
  var pool = [];

  directResults.concat(indirectResults).forEach(function (item) {
    var id = String(item.id);
    if (seenIds[id]) return;
    seenIds[id] = true;
    pool.push({ id: item.id, name: item.name });
  });

  try {
    var all = readSheetAsObjects_(SHEETS.INTERESTS);
    var sampleCount = Math.min(OVERLAP_CANDIDATE_RANDOM_SAMPLE, all.length);
    if (sampleCount > 0) {
      var step = Math.max(1, Math.floor(all.length / sampleCount));
      for (var i = 0; i < all.length && pool.length < OVERLAP_CANDIDATE_POOL_LIMIT; i += step) {
        var row = all[i];
        var id = String(row.id);
        if (!id || seenIds[id]) continue;
        seenIds[id] = true;
        pool.push({ id: row.id, name: row.name });
      }
    }
  } catch (e) {
    Logger.log('候選池隨機取樣失敗，僅用直接/間接相關的結果：' + e.message);
  }

  return pool.slice(0, OVERLAP_CANDIDATE_POOL_LIMIT);
}
