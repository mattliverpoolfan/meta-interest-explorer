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

/**
 * 回傳 {direct: string[], indirect: string[]}。
 * Gemini 呼叫失敗（額度、網路、格式跑掉）一律吞掉回傳空陣列，
 * 讓呼叫端可以退回到「只用原始字詞查詢」，不能讓整個搜尋掛掉。
 */
function classifyInterestCandidates_(query) {
  try {
    var config = getGeminiConfig_();
    var url = GEMINI_BASE + '/' + config.model + ':generateContent?key=' + encodeURIComponent(config.apiKey);
    var payload = {
      contents: [{ parts: [{ text: buildCandidatePrompt_(query) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: CANDIDATE_RESPONSE_SCHEMA,
      },
    };
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    var body = response.getContentText();
    if (code !== 200) {
      Logger.log('Gemini API 錯誤（HTTP ' + code + '）：' + body.slice(0, 500));
      return { direct: [], indirect: [] };
    }
    var json = JSON.parse(body);
    var text = json.candidates && json.candidates[0] && json.candidates[0].content &&
      json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
      json.candidates[0].content.parts[0].text;
    if (!text) {
      Logger.log('Gemini 回應沒有內容：' + body.slice(0, 500));
      return { direct: [], indirect: [] };
    }
    var parsed = JSON.parse(text);
    return {
      direct: Array.isArray(parsed.direct) ? parsed.direct : [],
      indirect: Array.isArray(parsed.indirect) ? parsed.indirect : [],
    };
  } catch (e) {
    Logger.log('classifyInterestCandidates_ 失敗，退回空清單：' + e.message);
    return { direct: [], indirect: [] };
  }
}
