/**
 * 一次搜尋、三類結果同時呈現的主要進入點：
 *   1. 直接相關 —— 原始字詞 + Gemini 聯想的同義詞，逐一送進 Meta 驗證存在
 *   2. 邏輯上間接相關 —— Gemini 推理受眾輪廓後聯想的詞，一樣要 Meta 驗證存在
 *   3. 受眾重疊比對 —— 挑一個種子標籤，跟候選池逐一算重疊，非同步跑（見 Overlap.gs）
 *
 * 前兩類只查候選詞、不查候選詞的候選詞，全程同步在一次 request 內跑完，
 * 所以「快」；第三類另外交給批次＋觸發器的非同步機制，這裡只負責啟動它。
 */

var UNIFIED_SEARCH_TERM_DELAY_MS = 100;
var UNIFIED_SEARCH_RESULT_LIMIT = 20;
var OVERLAP_CANDIDATE_POOL_LIMIT = 40;
var OVERLAP_CANDIDATE_RANDOM_SAMPLE = 30;

function handleUnifiedSearch_(query) {
  query = String(query || '').trim();
  if (!query) throw new Error('請輸入搜尋字詞');

  var gemini = classifyInterestCandidates_(query);

  var directTerms = dedupeStrings_([query].concat(gemini.direct || []));
  var indirectTerms = dedupeStrings_(gemini.indirect || []);

  var directResults = verifyTermsAgainstMeta_(directTerms, {});
  var directIds = {};
  directResults.forEach(function (item) { directIds[String(item.id)] = true; });

  var indirectResults = verifyTermsAgainstMeta_(indirectTerms, directIds);

  directResults = directResults.slice(0, UNIFIED_SEARCH_RESULT_LIMIT);
  indirectResults = indirectResults.slice(0, UNIFIED_SEARCH_RESULT_LIMIT);

  var overlapScan = null;
  var seed = pickSeed_(query, directResults);
  if (seed) {
    var candidatePool = buildCandidatePool_(seed, directResults, indirectResults);
    if (candidatePool.length) {
      overlapScan = startOverlapScan_(seed, candidatePool);
    }
  }

  return { direct: directResults, indirect: indirectResults, overlapScan: overlapScan };
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
 * 每個候選詞都是「搜尋詞」不是「答案」，逐一送進 Meta 的即時查詢驗證是否真的存在。
 * excludeIds：已經在別的類別出現過的標籤 id，這裡查到也不重複收錄。
 */
function verifyTermsAgainstMeta_(terms, excludeIds) {
  var seen = {};
  var out = [];
  terms.forEach(function (term, index) {
    if (index > 0) Utilities.sleep(UNIFIED_SEARCH_TERM_DELAY_MS);
    try {
      searchAdInterest_(term, 20, true).forEach(function (item) {
        var id = String(item.id);
        if (seen[id] || excludeIds[id]) return;
        seen[id] = true;
        out.push(item);
      });
    } catch (e) {
      Logger.log('候選詞「' + term + '」查詢失敗：' + e.message);
    }
  });
  return out;
}

/** 種子：直接相關裡跟原始字詞完全同名的優先，否則取直接相關第一筆；都沒有就跳過第三類 */
function pickSeed_(query, directResults) {
  if (!directResults.length) return null;
  var exact = directResults.filter(function (item) { return item.name === query; });
  return exact.length ? exact[0] : directResults[0];
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
