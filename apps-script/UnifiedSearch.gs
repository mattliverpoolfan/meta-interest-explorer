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

/**
 * 2026-09-09 實測抓到：像「投資」這種泛用詞，Meta 搜尋一次就補回 20 幾筆各種投資/
 * 股票/基金子分類，同一次搜尋裡單一候選詞就佔滿 forClassify 六成以上的名額，把
 * 「五星級飯店」「健康生活」這種當次查無精準匹配、Meta 沒補位任何結果的候選詞完全
 * 擠出去——結果看起來像「AI 聯想很沒有想像力」，其實 AI 聯想的詞本身夠多元
 * （精品／瑜珈／五星級飯店／高爾夫／投資／健康生活），問題是 Meta 端每個詞回補的
 * 數量天差地遠。每個候選詞的驗證結果先各自砍到這個上限，確保不會有單一詞洗版。
 */
var MAX_VERIFIED_PER_TERM = 6;

function handleUnifiedSearch_(query) {
  query = String(query || '').trim();
  if (!query) throw new Error('請輸入搜尋字詞');

  var gemini = classifyInterestCandidates_(query);
  var allTerms = dedupeStrings_([query].concat(gemini.direct || []).concat(gemini.indirect || []));

  // 直接用一份合併後的搜尋詞去查、去重，分類完全交給下一步統一判斷——
  // 不能用「這個詞原本被 AI 歸在哪一類」來決定結果的分類，那正是誤殺/漏網的來源
  // （Meta 對查無精準匹配的字詞常補位不相關的熱門標籤，即使搜尋詞本身看似「直接」）。
  var verified = verifyTermsAgainstMeta_(allTerms);

  // 2026-09-11 實測抓到：間接候選詞常常「邏輯推理是對的，字面用詞卻沒對上 Meta 標籤的
  // 命名習慣」，導致整個推理方向因為單一措辭沒撞上而平白漏掉。針對第一輪完全查無結果的
  // 間接候選詞，讓 AI 保留同一個推理方向、換幾種說法再試一次——只補救「用詞沒對上」，
  // 不是重新聯想新方向。
  var foundTerms = {};
  verified.forEach(function (e) { foundTerms[e.term] = true; });
  var failedIndirectTerms = (gemini.indirect || []).filter(function (t) { return !foundTerms[t]; });
  if (failedIndirectTerms.length) {
    var retryTerms = dedupeStrings_(regenerateFailedTerms_(query, failedIndirectTerms));
    if (retryTerms.length) {
      verified = dedupeVerifiedById_(verified.concat(verifyTermsAgainstMeta_(retryTerms)));
    }
  }

  var forClassify = verified.slice(0, CLASSIFY_INPUT_LIMIT);
  var classifications = classifyAndTierResults_(query, forClassify.map(function (e) {
    return { term: e.term, name: e.item.name };
  }));

  var aiClassificationFailed = classifications.length > 0 && classifications.every(function (c) { return c.aiFailed; });

  // 2026-09-09 實測抓到：分類（第一二類）完全沒有拿到候選詞自己的受眾規模，AI 純粹憑
  // 標籤名字的語意判斷該給哪一級。實測驗證過「瑜伽經」這個標籤在 Meta 上的真實受眾是
  // 0（不是規模小，是根本查無可投放受眾），但 AI 完全不知道這件事，照樣照文字語意給了
  // 一個看起來煞有介事的關聯等級——顯示出來的分級因此可能跟「這個標籤到底能不能真的拿
  // 去投放」完全脫鉤，讓使用者誤以為這是個有意義的選項。跟種子/候選池的規模門檻用同一套
  // 判斷邏輯，但這裡只擋真正「查無受眾」的（規模 0），不用第三類那麼嚴格的門檻——直接/
  // 間接相關的目的是給真實存在、可投放的選項，只要受眾不是 0 就有參考價值，不需要像第三類
  // 重疊比對那樣要求統計上有意義的規模。
  var directResults = [];
  var indirectByTier = { 1: [], 2: [], 3: [] };
  forClassify.forEach(function (entry, i) {
    var c = classifications[i] || { bucket: 'direct', tier: 0, closeness: 0 };
    if (c.bucket === 'unrelated') return;
    if (estimatedAudienceSize_(entry.item) <= 0) return;
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

/** 合併多輪 verifyTermsAgainstMeta_ 的結果時，同一個標籤可能被不同輪的候選詞重複查到。 */
function dedupeVerifiedById_(list) {
  var seen = {};
  var out = [];
  list.forEach(function (e) {
    var id = String(e.item.id);
    if (seen[id]) return;
    seen[id] = true;
    out.push(e);
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
      results.slice(0, MAX_VERIFIED_PER_TERM).forEach(function (item) {
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
 * 2026-09-09 實測抓到：候選標籤自己的受眾規模如果本來就逼近或等於 0（Meta 對極小眾
 * 標籤常常直接回傳 0，或是卡在 Meta 的最低回報門檻 1,000），拿去跟種子算交集，
 * 算出來的 overlap_ratio／lift 要嘛是無意義的 0%／0，要嘛因為分母（候選詞自己的規模）
 * 小到跟 Meta 回報下限一樣，交集剛好等於候選詞全部規模，數學上就是「100% 重疊、
 * lift 高到誇張」——不是真的發現了驚人關聯，是小樣本雜訊。種子規模夠大時這個問題
 * 特別明顯（種子受眾隨便都是幾十萬，任何規模只有 1,000 的候選詞幾乎必然「100% 落在
 * 種子受眾裡」）。用 Interests 分頁/搜尋結果裡已經存的規模欄位先擋掉，不用另外多打
 * API，也不會浪費第三類掃描的批次額度在這些注定沒有意義的 pair 上。
 */
var MIN_CANDIDATE_AUDIENCE_SIZE = 10000;

function estimatedAudienceSize_(item) {
  var lower = Number(item.audience_size_lower_bound) || 0;
  var upper = Number(item.audience_size_upper_bound) || lower;
  return (lower + upper) / 2;
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
    if (estimatedAudienceSize_(item) < MIN_CANDIDATE_AUDIENCE_SIZE) return;
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
        if (estimatedAudienceSize_(row) < MIN_CANDIDATE_AUDIENCE_SIZE) continue;
        seenIds[id] = true;
        pool.push({ id: row.id, name: row.name });
      }
    }
  } catch (e) {
    Logger.log('候選池隨機取樣失敗，僅用直接/間接相關的結果：' + e.message);
  }

  return pool.slice(0, OVERLAP_CANDIDATE_POOL_LIMIT);
}
