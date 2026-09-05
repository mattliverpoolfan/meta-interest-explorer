/**
 * Gemini API 呼叫封裝，只做一件事：把使用者輸入的原始字詞（可能是產品/品牌/概念，
 * 不一定是 Meta 後台真實存在的興趣標籤名稱）擴寫成兩組候選搜尋詞——
 * AI 只負責「聯想候選詞」，候選詞是不是真的存在還是要送進 Meta 驗證，
 * 這裡吐出來的東西絕對不會直接當成最終答案顯示給使用者。
 *
 * 手動在「專案設定 > 指令碼屬性」填入：
 *   GEMINI_API_KEY —— https://aistudio.google.com/apikey 申請
 *   GEMINI_MODEL   —— 選填，預設 gemini-2.5-flash
 */

var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function getGeminiConfig_() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('缺少 Script Property: GEMINI_API_KEY');
  return {
    apiKey: apiKey,
    model: props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash',
  };
}

var CANDIDATE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    direct: { type: 'ARRAY', items: { type: 'STRING' } },
    indirect: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['direct', 'indirect'],
};

function buildCandidatePrompt_(query) {
  return '你是一個資深 Meta（Facebook/Instagram）廣告受眾企劃。使用者輸入了一個字詞，' +
    '這個字詞可能是產品、品牌或概念，不一定是 Meta 廣告後台興趣標籤系統裡真實存在的名稱。\n\n' +
    '使用者輸入：「' + query + '」\n\n' +
    '請產生兩組候選的「Meta 興趣標籤搜尋詞」（這只是拿去 Meta 後台搜尋框驗證用的候選詞，' +
    '不是最終答案，之後系統會實際去 Meta 查證是否真的存在這個標籤）：\n\n' +
    '1. direct（直接相關）：使用者輸入字詞的直接同義詞、換句話說、或有經驗的媒體投手看到這個字詞會直覺聯想去試的興趣主題。' +
    '例如使用者輸入「慢跑鞋」，direct 應該包含「跑步」「慢跑」「路跑」這類詞——因為 Meta 標籤庫裡沒有「慢跑鞋」這個詞，' +
    '但這些直接相關的興趣詞是有的。給 3~6 個詞。\n\n' +
    '2. indirect（邏輯上間接相關）：不是同義詞，而是進一步推理「這個字詞背後的受眾輪廓，還會對什麼主題感興趣」。' +
    '例如使用者輸入跟嬰兒用品有關的字詞，背後的受眾是新手父母，indirect 可以給「房地產」「家電」「家庭用車」這類——' +
    '字面上跟嬰兒用品完全不相關，但這群人同時也在意這些事。給 3~6 個詞。\n\n' +
    '每個詞盡量精簡（2~6 個字），適合直接拿去 Meta 廣告後台的興趣搜尋框查詢，不要加任何說明文字。';
}

var GEMINI_CALL_ATTEMPTS = 2;
var GEMINI_RETRY_DELAY_MS = 800;

/**
 * Gemini generateContent 的共用呼叫封裝，回傳解析後的 JSON（依 schema），失敗回傳 null。
 * 呼叫端自己決定失敗時的退路——這裡不 throw，因為 AI 這塊都是「錦上添花」，
 * 不能讓 Gemini 的額度/網路問題擋掉整個搜尋。
 *
 * 實測過一次分類判斷（classifyAndTierResults_）因為單次呼叫的暫時性網路/額度問題失敗，
 * 導致整批結果退回「全部當作直接相關」、雜訊沒被濾掉——這種偶發失敗重試一次通常就過了，
 * 所以這裡跟前端 fetchJsonWithRetry 一樣加上重試，不能讓單次network hiccup 就讓使用者
 * 看到一坨沒分類過的原始結果。
 */
function callGemini_(prompt, schema) {
  var config;
  try {
    config = getGeminiConfig_();
  } catch (e) {
    Logger.log('callGemini_ 設定錯誤：' + e.message);
    return null;
  }
  var url = GEMINI_BASE + '/' + config.model + ':generateContent?key=' + encodeURIComponent(config.apiKey);
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: 8192,
    },
  };

  var lastError = '';
  for (var attempt = 1; attempt <= GEMINI_CALL_ATTEMPTS; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      var code = response.getResponseCode();
      var body = response.getContentText();
      if (code !== 200) {
        lastError = 'HTTP ' + code + '：' + body.slice(0, 300);
      } else {
        var json = JSON.parse(body);
        var candidate = json.candidates && json.candidates[0];
        var text = candidate && candidate.content && candidate.content.parts &&
          candidate.content.parts[0] && candidate.content.parts[0].text;
        if (!text) {
          lastError = '回應沒有內容（finishReason=' + (candidate && candidate.finishReason) + '）：' + body.slice(0, 300);
        } else {
          return JSON.parse(text);
        }
      }
    } catch (e) {
      lastError = e.message;
    }
    if (attempt < GEMINI_CALL_ATTEMPTS) Utilities.sleep(GEMINI_RETRY_DELAY_MS);
  }
  Logger.log('callGemini_ 重試 ' + GEMINI_CALL_ATTEMPTS + ' 次都失敗：' + lastError);
  return null;
}

/**
 * 回傳 {direct: string[], indirect: string[]}。
 * Gemini 呼叫失敗（額度、網路、格式跑掉）一律吞掉回傳空陣列，
 * 讓呼叫端可以退回到「只用原始字詞查詢」，不能讓整個搜尋掛掉。
 */
function classifyInterestCandidates_(query) {
  var parsed = callGemini_(buildCandidatePrompt_(query), CANDIDATE_RESPONSE_SCHEMA);
  if (!parsed) return { direct: [], indirect: [] };
  return {
    direct: Array.isArray(parsed.direct) ? parsed.direct : [],
    indirect: Array.isArray(parsed.indirect) ? parsed.indirect : [],
  };
}

var CLASSIFY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          bucket: { type: 'STRING', enum: ['direct', 'indirect', 'unrelated'] },
          tier: { type: 'INTEGER' },
        },
        required: ['bucket', 'tier'],
      },
    },
  },
  required: ['results'],
};

/**
 * candidates: [{term, name}]——term 是拿去查 Meta 的搜尋詞（可能是使用者原始字詞，
 * 也可能是 AI 聯想出的候選詞），name 是 Meta 已經確認真實存在的標籤名稱。
 *
 * 這一步做的是「重新分類」，不是「篩選」：每一筆都已經是 Meta 真實存在的標籤，這裡
 * 只決定它該落在哪一類、間接相關的話關聯強度多少。刻意不依賴「它是從哪個搜尋詞查到
 * 的」來決定分類——搜尋詞本身可能就是誤判的來源（Meta 對查無精準匹配的字詞常會補位
 * 不相關的熱門標籤，例如搜「SPA」卻查到「動作片」），所以即使某筆是從一個「直接」
 * 搜尋詞查到的，只要實際上關聯薄弱也要判成 unrelated 整個排除；反過來，只要關聯夠
 * 直接，就算來源詞是系統標成「間接」的，也可以被歸類成 direct。
 *
 * bucket: 'direct' 直接相關 / 'indirect' 邏輯上間接相關 / 'unrelated' 完全無關（丟掉，
 * 不顯示給使用者）。
 * tier：只有 bucket='indirect' 時才有意義，1=高關聯度（邏輯清楚，適合優先測試）、
 * 2=中關聯度（合理但需要驗證）、3=推測性關聯（跳躍程度較大，適合大膽嘗試）；
 * bucket 不是 indirect 時填 0。
 *
 * 回傳跟 candidates 等長、順序一致的 {bucket, tier} 陣列；Gemini 失敗時全部退回
 * bucket='direct'——寧可退回沒有分類/分級的舊版體驗，也不能讓這步的失敗擋掉整個搜尋。
 */
function classifyAndTierResults_(query, candidates) {
  if (!candidates.length) return [];
  var prompt = '使用者在 Meta 廣告受眾探索工具搜尋「' + query + '」。以下是系統實際查到、已經確認在 Meta ' +
    '廣告後台真實存在的興趣標籤候選清單（JSON 陣列，term 是拿去搜尋的詞，name 是查到的標籤名稱）：\n' +
    JSON.stringify(candidates.map(function (c) { return { term: c.term, name: c.name }; })) + '\n\n' +
    '請針對每一筆，依照原本順序判斷該歸類到哪一類：\n\n' +
    '"direct"（直接相關）：字面同義詞、非常直覺會聯想到的興趣，或本身就是使用者輸入字詞的常見說法差異。\n\n' +
    '"indirect"（邏輯上間接相關）：不是同義詞，但背後推理得通——這群人因為某個共同的受眾輪廓，也會對這個' +
    '主題感興趣（例如搜「SPA」查到「度假村」：不是同義詞，但 SPA 度假村是合理的關聯情境）。這類要再給 ' +
    'tier：1=高關聯度（邏輯清楚，適合優先測試）、2=中關聯度（合理但需要驗證）、3=推測性關聯（跳躍程度' +
    '較大，適合大膽嘗試）。\n\n' +
    '"unrelated"（完全無關）：Meta 搜尋 API 查無精準匹配時常會補位一些毫不相干的熱門標籤（例如搜「單車」' +
    '卻混進「劇情片」），這種即使它是從某個看起來像直接相關的搜尋詞查到的，只要實際上想不出任何合理' +
    '關聯，都要判成 unrelated，這樣系統才會把它整個排除、不顯示給使用者。\n\n' +
    '按照原本順序回傳一個等長的 JSON 陣列（放在 results 欄位），每個元素是 {"bucket": "...", "tier": 數字}' +
    '（bucket 不是 indirect 時 tier 填 0）。';
  var parsed = callGemini_(prompt, CLASSIFY_RESPONSE_SCHEMA);
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== candidates.length) {
    Logger.log('classifyAndTierResults_ 回傳格式不對或失敗，退回全部視為 direct（沒有分類/分級）');
    return candidates.map(function () { return { bucket: 'direct', tier: 0 }; });
  }
  return parsed.results;
}
