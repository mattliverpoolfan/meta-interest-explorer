/**
 * Gemini API 呼叫封裝，只做一件事：把使用者輸入的原始字詞（可能是產品/品牌/概念，
 * 不一定是 Meta 後台真實存在的興趣標籤名稱）擴寫成兩組候選搜尋詞——
 * AI 只負責「聯想候選詞」，候選詞是不是真的存在還是要送進 Meta 驗證，
 * 這裡吐出來的東西絕對不會直接當成最終答案顯示給使用者。
 *
 * 手動在「專案設定 > 指令碼屬性」填入：
 *   GEMINI_API_KEY    —— https://aistudio.google.com/apikey 申請
 *   GEMINI_API_KEY_2  —— 選填，第二支金鑰（不同 Google 帳號/專案申請的獨立金鑰，
 *                         額度不共用）。之後想再加第三支，比照這個命名規則加
 *                         GEMINI_API_KEY_3，並在下面 getGeminiApiKeys_() 補一行即可。
 *
 * 2026-09-05 實測抓到：Gemini 免費方案的額度是「每個模型各自」每天限額（不是整個
 * 帳號共用一包），所以某個模型的額度用完時，換一個模型打還是有機會成功。這裡改成
 * 「依智慧程度排序的模型清單 × 所有可用金鑰」的雙層 fallback：對最強的模型，把每一
 * 支金鑰都試過一輪，才會退而求其次換下一個較弱的模型（一樣把每支金鑰都試一輪）。
 * 不再讀取單一模型的 GEMINI_MODEL 屬性——已經被下面 GEMINI_MODEL_PRIORITY 取代。
 */

var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 依智慧程度由強到弱排序，最上面優先用。這份排序是照 Google 一貫的命名慣例
 * （Pro > Flash > Flash Lite；同系列世代數字越大越新）做的判斷，不是每個模型都
 * 實測驗證過相對能力——如果之後發現某個模型的免費額度或實際表現跟這裡排的不一樣，
 * 直接調整這個陣列順序即可，不用動其他程式碼。Pro 系列在免費方案通常沒有額度
 * （呼叫會直接失敗被跳過），但保留在清單最前面，之後帳戶升級成付費方案就會自動
 * 優先用到，不用再回來改程式碼。
 */
var GEMINI_MODEL_PRIORITY = [
  'gemini-3.1-pro',
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
];

/** 依序讀取所有設定過的金鑰，沒設定的（例如還沒申請第二支）自動跳過。 */
function getGeminiApiKeys_() {
  var props = PropertiesService.getScriptProperties();
  var keys = [
    props.getProperty('GEMINI_API_KEY'),
    props.getProperty('GEMINI_API_KEY_2'),
  ];
  return keys.filter(function (k) { return !!k; });
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
    '1. direct（直接相關）：使用者輸入字詞的直接同義詞、換句話說、或同一個領域裡的其他子類別/品牌/變化型' +
    '（有經驗的媒體投手看到這個字詞會直覺聯想去試的興趣主題，都算這類）。例如使用者輸入「慢跑鞋」，direct ' +
    '應該包含「跑步」「慢跑」「路跑」這類詞；使用者輸入一個特定運動賽事，direct 可以包含其他相近的訓練方式、' +
    '該項運動的其他知名品牌或社群——重點是「還在同一個領域裡」。給 3~6 個詞。\n\n' +
    '2. indirect（邏輯上間接相關）：**不能只是同一個領域裡的其他子類別或品牌**（那些屬於 direct），而是要' +
    '真正跳到不同的領域/主題，推理「這群受眾背後的生活型態或消費輪廓，還會對什麼完全不同的主題感興趣」。' +
    '例如使用者輸入跟嬰兒用品有關的字詞，背後的受眾是新手父母，indirect 可以給「房地產」「家電」「家庭用車」' +
    '這類——字面上跟嬰兒用品完全不相關，但這群人同時也在意這些事；又例如使用者輸入一個高強度競賽型運動賽事' +
    '（例如混合健身競賽），indirect 不該再給其他健身房或訓練方式（那是 direct），而該推理「願意花錢報名這種' +
    '競賽的人，還會是什麼樣的消費者」——例如運動穿戴裝置、運動營養補充品、其他強調挑戰性/自我突破的活動' +
    '（越野跑、鐵人三項這類不同運動但同樣訴求自我挑戰的族群）、高消費力的生活風格指標。給 3~6 個詞，盡量' +
    '涵蓋不同的延伸方向，不要每個詞都停留在同一個小圈子裡。\n\n' +
    '每個詞盡量精簡（2~6 個字），適合直接拿去 Meta 廣告後台的興趣搜尋框查詢，不要加任何說明文字。';
}

var GEMINI_CALL_ATTEMPTS = 2; // 針對「同一組模型+金鑰」暫時性錯誤（非額度用完）的重試次數
var GEMINI_RETRY_DELAY_MS = 800;

/**
 * Gemini generateContent 的共用呼叫封裝，回傳解析後的 JSON（依 schema），全部組合都
 * 失敗才回傳 null。呼叫端自己決定失敗時的退路——這裡不 throw，因為 AI 這塊都是
 * 「錦上添花」，不能讓 Gemini 的額度/網路問題擋掉整個搜尋。
 *
 * 依「模型（智慧程度由強到弱）× 金鑰」雙層跑：對最強的模型，把每一支金鑰都試過
 * 一輪，才會換下一個較弱的模型——這樣同一次查詢會盡量用最好的模型，只有在那個
 * 模型的所有金鑰都額度用完時，才會降級用次一級的模型。
 */
function callGemini_(prompt, schema) {
  var apiKeys = getGeminiApiKeys_();
  if (!apiKeys.length) {
    Logger.log('callGemini_ 設定錯誤：找不到任何 GEMINI_API_KEY');
    return null;
  }

  for (var m = 0; m < GEMINI_MODEL_PRIORITY.length; m++) {
    var model = GEMINI_MODEL_PRIORITY[m];
    for (var k = 0; k < apiKeys.length; k++) {
      var result = callGeminiOnce_(model, apiKeys[k], prompt, schema);
      if (result !== null) return result;
    }
  }
  Logger.log('callGemini_ 所有模型/金鑰組合都失敗，放棄');
  return null;
}

/**
 * 對「單一模型 + 單一金鑰」這個組合發出請求，失敗回傳 null 讓外層換下一組合。
 * 429（額度用完）直接放棄不重試——Google 給的 retryDelay 是幾十秒起跳，不是這裡的
 * 重試間隔（不到 1 秒）救得了的，換一組模型/金鑰組合比原地重試快得多也有用得多。
 * 其他錯誤（網路、格式跑掉）才用短間隔重試個一兩次，這種通常是暫時性問題。
 */
function callGeminiOnce_(model, apiKey, prompt, schema) {
  var url = GEMINI_BASE + '/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);
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
      if (code === 429) {
        Logger.log(model + '（金鑰末四碼 ' + apiKey.slice(-4) + '）額度用完（HTTP 429），換下一組：' + body.slice(0, 200));
        return null;
      }
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
  Logger.log(model + '（金鑰末四碼 ' + apiKey.slice(-4) + '）重試 ' + GEMINI_CALL_ATTEMPTS + ' 次都失敗，換下一組：' + lastError);
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
    '"direct"（直接相關）：字面同義詞、非常直覺會聯想到的興趣，或是**同一個領域裡的其他子類別/品牌/變化型**' +
    '（例如都還是健身房品牌、都還是同一種運動賽事、都還是同一項產品的不同款式）——即使字面不完全相同，只要' +
    '本質上還是同一個領域，都算 direct。\n\n' +
    '"indirect"（邏輯上間接相關）：**必須是真正跳到不同領域/主題**，因為某個共同的受眾輪廓，這群人也會對這個' +
    '完全不同的主題感興趣（例如搜「SPA」查到「度假村」：從美容保養跳到旅遊住宿，是不同領域；但如果查「某個' +
    '健身品牌」卻查到「另一個健身房品牌」，那還是同一個領域，該判 direct 不是 indirect）。這類要再給 tier：\n' +
    '  1=高關聯度：邏輯非常清楚，同溫層受眾組成明顯有共同點（例如跑者通常也做重訓）。\n' +
    '  2=中關聯度：合理但不是每個人都會立刻想到，需要多一層推理（例如馬拉松跑者可能也在意運動保險）。\n' +
    '  3=推測性關聯：需要比較大膽的受眾輪廓推理才能連得上，例如從活動類型聯想到消費力、生活風格、社群認同' +
    '這類更抽象的面向（例如願意花錢報名高強度競賽的人，可能也對高單價穿戴裝置或客製化營養品有興趣）——這一' +
    '級允許更跳躍，只要邏輯講得通就可以給，不用每筆都很有把握才給 tier 1，也不要因為不確定就不給 tier 3、' +
    '全部塞進 tier 2。\n\n' +
    '"unrelated"（完全無關）：Meta 搜尋 API 查無精準匹配時常會補位一些毫不相干的熱門標籤（例如搜「單車」' +
    '卻混進「劇情片」），這種即使它是從某個看起來像直接相關的搜尋詞查到的，只要實際上想不出任何合理' +
    '關聯，都要判成 unrelated，這樣系統才會把它整個排除、不顯示給使用者。\n\n' +
    '實際案例幫助你抓分寸：使用者搜尋一個混合健身競賽（例如 Hyrox）。查到「CrossFit Training」「高強度間歇' +
    '訓練」「肌力訓練」「健身服務」——這些都還是健身訓練這個領域裡的東西，判 direct。查到「露營」「園藝」' +
    '「旅遊和戶外活動創作者」——雖然都帶點「戶外」的味道，但露營是戶外休閒、園藝是居家嗜好、旅遊創作者是' +
    '內容創作職業，這些已經是跟「健身訓練」不同的生活領域，不該判 direct；正確判法是 indirect（推理邏輯：' +
    '願意報名高強度競賽的人，通常也是熱愛自我挑戰、熱衷戶外生活的人，所以也會對露營這類戶外休閒感興趣——' +
    '這是受眾輪廓的間接推理，不是訓練方式的同領域延伸）。**判斷時只看這個候選標籤本身的性質，不要因為它' +
    '看起來也沾得上「戶外」「運動」這類寬泛字眼，就放寬標準判成 direct**。\n\n' +
    '按照原本順序回傳一個等長的 JSON 陣列（放在 results 欄位），每個元素是 {"bucket": "...", "tier": 數字}' +
    '（bucket 不是 indirect 時 tier 填 0）。';
  var parsed = callGemini_(prompt, CLASSIFY_RESPONSE_SCHEMA);
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== candidates.length) {
    Logger.log('classifyAndTierResults_ 回傳格式不對或失敗，退回全部視為 direct（沒有分類/分級）');
    return candidates.map(function () { return { bucket: 'direct', tier: 0 }; });
  }
  return parsed.results;
}
