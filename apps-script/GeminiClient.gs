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
 * 依智慧程度由強到弱排序，最上面優先用。
 *
 * 2026-09-08 修正：舊清單裡的 `gemini-3.1-pro`、`gemini-3-flash` 是憑 Google 命名慣例猜的，
 * 用暫時的除錯端點直接打 ListModels + 逐一實測 generateContent 後發現**根本不存在**（打
 * 下去直接 404），`gemini-2.5-pro` 雖然在 ListModels 裡列得出來，但這把金鑰打下去也是
 * 404「不再開放給新用戶」。等於舊清單 6 個裡有 3 個是完全打不通的死路——每次呼叫都要先
 * 白白浪費兩次（每個死模型還會重試一次）注定失敗的請求，才會走到真正能用的模型，這正是
 * 搜尋常常要等 40~130 秒、而且額度感覺消耗特別快的主因之一（能真正分攤額度的模型其實只有
 * 原本清單的一半）。
 *
 * 下面這份改成實測過 ListModels + 逐一 generateContent 探測、**真的會回 200** 的模型名字
 * （用同一把金鑰測的）。`gemini-*-latest` 這幾個是 Google 提供的別名，會自動指向該層級
 * 目前最新的正式模型，好處是以後 Google 換版本不用回來改這個清單；**但這幾個別名底層實際
 * 對應到哪個模型、額度是不是跟其他清單裡的模型共用同一個配額桶，沒有進一步驗證過**，如果
 * 之後發現某個別名總是跟緊接在它旁邊的具體模型同時 429，很可能就是共用同一桶，可以考慮拿掉
 * 其中一個。Pro 系列（`gemini-pro-latest`）目前免費額度是 0（打下去直接 429），保留在清單
 * 最前面，帳戶之後升級付費方案會自動優先用到。
 */
var GEMINI_MODEL_PRIORITY = [
  'gemini-pro-latest',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
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
    '（越野跑、鐵人三項這類不同運動但同樣訴求自我挑戰的族群）、高消費力的生活風格指標。給 8~12 個詞，' +
    '**盡量橫跨至少 4~5 個完全不同的延伸角度**（例如：生活風格/嗜好、消費力/品味指標、人口統計輪廓' +
    '（例如新手父母、退休族、通勤族這類身分標籤）、同時期會做的其他行為、價值觀/自我認同這類），每個角度' +
    '給 1~3 個詞就好，不要為了湊數在同一個角度裡重複產生相似詞——寧可犧牲同一角度的深度，也要優先確保' +
    '角度的廣度，因為候選詞之後還要靠字面去 Meta 搜尋框比對，角度越分散，越不容易因為單一措辭沒對上' +
    '就整個角度掛零。\n\n' +
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

var RETRY_TERMS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          original: { type: 'STRING' },
          alternatives: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['original', 'alternatives'],
      },
    },
  },
  required: ['results'],
};

/**
 * 2026-09-11 新增：間接候選詞常常「邏輯推理是對的，但字面用詞沒對上 Meta 標籤的命名習慣」，
 * 導致 Meta 搜尋框查無結果、整個推理方向平白漏掉。這裡針對查無結果的間接候選詞，讓 AI
 * **保留原本的推理方向、只換字面說法**再試一次，提高文字比對命中真實標籤的機率——
 * 不是重新聯想新方向（那是 classifyInterestCandidates_ 的事），純粹是換句話說。
 */
function buildRetryPrompt_(query, failedTerms) {
  return '你先前針對使用者搜尋「' + query + '」提出了幾個「邏輯上間接相關」的候選詞，但這些詞拿去 Meta ' +
    '廣告後台的興趣標籤搜尋框查詢，完全沒有查到任何真實存在的標籤（可能是措辭不夠貼近 Meta 標籤的命名' +
    '習慣，不是邏輯推理本身有問題）：\n' + JSON.stringify(failedTerms) + '\n\n' +
    '請針對清單裡的每一個詞，**保留原本的邏輯推理方向不變，不要換成不同的主題或不同的推理**，只是換 ' +
    '2~3 種不同的具體說法/同義詞/更貼近一般興趣標籤命名習慣的講法，試著提高查到真實標籤的機率（例如原詞' +
    '是抽象的生活風格描述，可以換成更具體的品牌、活動、次領域名稱；原詞是中文可以試著給對應的英文說法，' +
    '反之亦然；原詞太長太抽象，可以拆成更精簡、更像標籤名稱的詞）。每個詞盡量精簡（2~6 個字）。\n\n' +
    '按照原本順序回傳一個等長的 JSON 陣列（放在 results 欄位），每個元素是 {"original": "原詞", ' +
    '"alternatives": ["替代說法1", "替代說法2", ...]}，不要加任何說明文字。';
}

var RETRY_MAX_FAILED_TERMS = 5;

/**
 * failedTerms：第一輪查無任何結果的間接候選詞。回傳打平後的替代說法字串陣列，
 * 直接丟給呼叫端重新驗證是否真的存在於 Meta。Gemini 失敗就回空陣列，不影響原本流程。
 */
function regenerateFailedTerms_(query, failedTerms) {
  if (!failedTerms.length) return [];
  var capped = failedTerms.slice(0, RETRY_MAX_FAILED_TERMS);
  var parsed = callGemini_(buildRetryPrompt_(query, capped), RETRY_TERMS_RESPONSE_SCHEMA);
  if (!parsed || !Array.isArray(parsed.results)) return [];
  var out = [];
  parsed.results.forEach(function (r) {
    if (Array.isArray(r.alternatives)) {
      r.alternatives.forEach(function (alt) {
        if (alt) out.push(String(alt));
      });
    }
  });
  return out;
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
          closeness: { type: 'INTEGER' },
        },
        required: ['bucket', 'tier', 'closeness'],
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
 * closeness：只有 bucket='direct' 時才有意義（0~100），衡量這個標籤跟使用者原始搜尋詞
 * 「本尊程度」的接近程度——100 分表示幾乎就是同一個東西（例如搜「慢跑鞋」查到「慢跑」這種
 * 幾乎同義的活動本身），分數越低表示雖然還在同一個領域，但比較像是同領域裡的「其他子類別/
 * 品牌/變化型」而不是使用者原本要找的那個東西本身。這個分數是拿來在沒有精準比對到的情況下，
 * 挑一個「最接近原意」的標籤當受眾重疊比對的種子用，不是 direct 時填 0。
 *
 * 回傳跟 candidates 等長、順序一致的 {bucket, tier, closeness} 陣列。Gemini 完全失敗時
 * （額度用完、網路問題等），**不能**照舊全部退回 bucket='direct'——那樣會把 Meta 對查無
 * 精準匹配的字詞補位回來的不相關熱門標籤，全部當成「直接相關」顯示給使用者，比不顯示還糟。
 * 保守退回：只有跟搜尋詞完全同名的那筆留著當 direct，其餘全部排除（unrelated），並且每筆都
 * 標記 aiFailed=true，讓呼叫端知道這是「AI 分類暫時無法使用」的退化結果，可以在畫面上提醒
 * 使用者，而不是靜靜地展示一批可能是雜訊的「直接相關」。
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
    '**一致性原則（避免同一個大主題底下的候選詞被隨意拆成不同等級）**：候選清單裡常會出現多筆本質上屬於' +
    '同一個廣義主題/概念、只是子類型、流派、呈現形式不同的候選詞（例如「瑜珈（靈性）」「訶陀瑜伽」「瑜伽經」' +
    '都屬於「瑜伽」這個大主題，只是一個是廣義靈性修行、一個是具體練習流派、一個是經典文本）。判斷這類候選詞' +
    '跟搜尋詞的關聯度時，**請先判斷「這整個大主題」跟搜尋詞的關聯邏輯是什麼，同一個大主題底下的候選詞原則上' +
    '應該落在同一個 bucket、同一個 tier**——不要只因為某一筆的名稱字面比較抽象（例如是理論、經典、文獻類），' +
    '或不像具體的「活動/消費行為」，就把它判得比同主題的其他候選詞明顯更低。只有在這個子類型代表的意涵，對' +
    '「這群受眾會不會也對搜尋詞感興趣」這個問題有實質、講得出道理的差異時（而不是單純字面用詞比較抽象），' +
    '才允許給不同的 bucket 或 tier。\n\n' +
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
    'closeness（只有 bucket="direct" 時才填有意義的值，其餘填 0）：0~100 分，衡量這個標籤跟使用者原始' +
    '搜尋詞「本尊程度」的接近程度——100 分表示幾乎就是同一個東西本身（例如搜「慢跑鞋」查到「慢跑」這種' +
    '幾乎同義的活動；搜尋詞剛好完全同名的當然也是 100），分數越低表示雖然還在同一個領域，但比較像是' +
    '「其他子類別/品牌/變化型」，不是使用者原本要找的那個東西本身（例如搜「慢跑鞋」查到「跑步機」——' +
    '同樣是跑步領域的裝備，但跟「鞋子」本身的距離比「慢跑」這個動作要遠，closeness 該給比較低的分數）。' +
    '這個分數是拿來在沒有精準比對到搜尋詞本身時，從 direct 裡面挑一個「最接近原意」的標籤當受眾重疊比對' +
    '的種子錨點用，請務必依照真實的語意距離給分、拉開差距，不要每筆都給差不多的分數。\n\n' +
    '按照原本順序回傳一個等長的 JSON 陣列（放在 results 欄位），每個元素是 {"bucket": "...", "tier": 數字, ' +
    '"closeness": 數字}（bucket 不是 indirect 時 tier 填 0；bucket 不是 direct 時 closeness 填 0）。';
  var parsed = callGemini_(prompt, CLASSIFY_RESPONSE_SCHEMA);
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== candidates.length) {
    Logger.log('classifyAndTierResults_ 回傳格式不對或失敗（可能是 Gemini 額度用完），保守退回：只留下跟' +
      '搜尋詞完全同名的當 direct，其餘一律排除，避免把 Meta 補位的不相關雜訊誤標成直接相關顯示給使用者');
    return candidates.map(function (c) {
      return c.name === query
        ? { bucket: 'direct', tier: 0, closeness: 100, aiFailed: true }
        : { bucket: 'unrelated', tier: 0, closeness: 0, aiFailed: true };
    });
  }
  return parsed.results;
}
