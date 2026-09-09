# CLAUDE.md — Meta 興趣受眾探索工具

給接手這個專案的 Claude（或任何 Agent）看的專案說明。這份文件取代原本的 `HANDOFF.md`（該檔案只存在於舊的 public repo 本機副本，因為那個 repo 是公開的，內部維運細節不方便進公開歷史紀錄；這個 repo 是私有的，所以把完整脈絡直接整理進這裡）。

## 這個工具在做什麼

系統化枚舉 Meta 目前實際開放的興趣標籤、找關聯興趣、估算重疊度，取代使用者原本「憑印象亂猜關鍵字」的受眾發想方式。一次搜尋同時呈現三類受眾發想結果：

1. **① 直接相關**：跟搜尋詞同義/同類別的 Meta 興趣標籤（查無則顯示「查無直接相關」，引導去看②）。
2. **② 邏輯上間接相關**：AI 推理受眾輪廓後聯想出的跨領域標籤，依關聯強度分三級——高關聯度／中關聯度／推測性關聯，UI 明確標示分級邏輯。
3. **③ 受眾重疊比對**：挑一個種子標籤，跟候選池逐一算 Meta 受眾重疊率，非同步跑（跑起來慢，前端顯示進度）。

## 架構

**Google Sheets（資料庫）+ Google Apps Script（後端 Web App）+ 純 HTML/JS 前端（GitHub Pages）**。

- 後端程式碼：`apps-script/*.gs`，用 [`clasp`](https://github.com/google/clasp)（Google 官方 CLI）推送，**不要**在 Apps Script 線上編輯器貼大量程式碼（貼上大段 base64/長字串曾經驗證過會字元遺漏/錯位，一定要用 `clasp push`）。
- 前端：`docs/*`，純靜態 HTML/JS/CSS，部署在 GitHub Pages（見下面「哪個 repo 對應哪個用途」）。
- 資料庫：單一 Google Sheets 試算表，包含 `Interests` / `Categories` / `Snapshots` / `RelatedCache` / `OverlapCache` / `SeedKeywords` 分頁。**這份試算表綁定 Apps Script 專案（內含 Meta Token 等機密屬性），絕對不能分享編輯權限給外部人員**——要分享工具給別人用，一律只分享前端網址。

## 哪個 repo 對應哪個用途（2026-09-05 起兩個 repo 並存）

- **Public repo**（`https://github.com/mattliverpoolfan/meta-interest-explorer`，[live 前端](https://mattliverpoolfan.github.io/meta-interest-explorer/)）：GitHub Pages 靠這個 repo 是 public 才能免費跑（private repo 要 GitHub Pro/Team/Enterprise 才能開 Pages）。**實際運作的規則（2026-09-08 起）**：真的會影響線上工具的修正（bug fix、前端行為改動）兩邊都要推，不能只留在私有 repo——不然使用者看到的 live 網站就一直是壞的。只有內部維運/文件性質的東西（像這份 `CLAUDE.md` 本身、`.gitignore` 這類）才只留在私有 repo，不用推去 public。
- **這個私有 repo**：接續開發用，方便在 M1 伺服器上 `git clone` 下來繼續改。因為是私有的，可以把完整維運脈絡（帳戶 ID、部署細節、踩過的坑）直接寫進這份 `CLAUDE.md`，不用像以前那樣另外開一份不進 git 的 `HANDOFF.md`。
- 兩邊目前是同一份 git 歷史分岔出去的（不是全新的 repo），程式碼實質相同，只是這個私有 repo 之後會繼續往前走，public repo 停在遷移當下的版本。**如果之後私有 repo 這邊改了後端 `apps-script/*.gs` 的邏輯，別忘了同一套 `clasp push`/`clasp deploy` 流程仍然是對著同一個 Apps Script 專案生效**——這兩個 git repo 只是原始碼的存放位置，跟 Apps Script 專案／Google Sheets 資料庫是分開的東西，不會因為換了 git remote 就換了後端。

## ⚠️ 最重要的固定流程：`clasp deploy` 之後一定要手動修「誰可以存取」

`clasp deploy -i <既有 deploymentId>` 更新既有部署版本後，Google 會把「誰可以存取」從「所有人」重設成「所有已登入 Google 帳戶的使用者」，導致前端匿名呼叫 API 全部變成要求登入（curl/fetch 拿到 Google 登入頁而不是 JSON）。**每次 `clasp deploy` 完，一定要**：

Apps Script 編輯器 → 部署（右上角，常常要點兩次選單才會真的展開）→ 管理部署作業 → 選中該部署 → 編輯（鉛筆圖示，不是滾輪齒輪）→「誰可以存取」下拉選單選回「所有人」→ 部署。

改完可以用 `curl -sL "<WEBAPP_URL>?action=refreshStatus"` 驗證，回傳合法 JSON（例如 `{"running":false}`）就對了，如果拿到 HTML 登入頁就是還沒修。

目前使用中的部署網址寫死在 `docs/app.js` 的 `WEBAPP_URL` 常數裡，要換部署網址得改這行程式碼（前端已經沒有「貼網址」欄位）。

## Script Properties（存在 Apps Script 專案設定 > 指令碼屬性，實際值不寫進這份文件）

去 Apps Script 編輯器的「專案設定」頁面看實際值，這台機器如果 Chrome 已登入使用者帳號可以直接看到，換一台機器接手則需要使用者自己開 Apps Script 專案給你看，或請使用者自己貼值進去（**不要**替使用者輸入真正的密鑰值——只新增屬性「名稱」，值留給使用者自己貼）。

| 屬性 | 用途 |
|---|---|
| `META_ACCESS_TOKEN` | Meta access token，需要 `ads_management` 權限 |
| `META_AD_ACCOUNT_ID` | 目前指向的廣告帳戶 ID |
| `APP_API_KEY` | 保護 `estimateOverlap`／`unifiedSearch`／`refreshSnapshot` 用的密碼。分享連結帶 `?key=該密碼`，`docs/app.js` 的 `init()` 自動存進 localStorage 並清掉網址列，之後開一般網址也能用 |
| `GEMINI_API_KEY` / `GEMINI_API_KEY_2` | `GeminiClient.gs` 呼叫 Gemini API 用，兩支輪替（見下面「Gemini 額度」一節）。去 https://aistudio.google.com/apikey 申請。**`GEMINI_API_KEY_2` 目前的值是佔位字串 `PLACEHOLDER_REPLACE_ME`，還沒換成真的金鑰** |
| `TOTAL_POPULATION_ESTIMATE` | 不是手動填的，`getTotalPopulationEstimate_()`（`Overlap.gs`）第一次用到時自己算好存起來當快取，算 lift 指標的標準化基準 |

## 核心邏輯與設計決策

### 三類結果為什麼要「候選詞驗證」而不是「候選詞直接當結果」

`UnifiedSearch.gs` 的 `handleUnifiedSearch_`：AI（Gemini）只負責把使用者輸入的原始字詞聯想成候選搜尋詞（`direct` + `indirect`），**候選詞一定要送進 Meta 實際搜尋驗證存在，才會出現在結果裡**，不會有 AI 幻覺出來的假標籤。驗證時 `verifyTermsAgainstMeta_` 先查 `Interests` 快取（`searchCachedInterests_`，`MetaClient.gs`），查無才退回即時 Meta 搜尋——降低撞到 Meta 即時搜尋補位雜訊的機率。

### 分類/分級用「重新分類」而不是「過濾」

驗證通過的候選詞，**不是**用「這個詞原本被 AI 歸在 direct 還是 indirect」來決定它最後顯示在哪一類——那樣容易誤殺（例如「SPA」搜出「度假村」，字面上像雜訊但其實是合理結果）。而是把所有驗證通過的真實 Meta 標籤丟進 `classifyAndTierResults_`（`GeminiClient.gs`）統一重新判斷該進 direct / indirect（含分級：高/中/推測性）/ unrelated，只有 `unrelated` 會被丟棄，其餘都會顯示出來、只是分到不同類別——**目標是不誤殺任何真實存在的合理結果，寧可分類分錯也不要憑空消失**。

### 種子標籤選擇（2026-09-08 改版）：AI 判斷語意最接近的，不是規模最小的

`pickSeed_`（`UnifiedSearch.gs`）：直接相關裡跟原字詞完全同名的優先當種子（`reason: '與搜尋詞完全相符'`）。

沒有精準對應時，**選 AI 判斷「語意上跟原字詞最接近」的那一筆**——`classifyAndTierResults_`（`GeminiClient.gs`）在判斷 bucket/tier 的同時，也會替每個 `direct` 分類的項目打一個 0~100 的 `closeness` 分數（衡量「這個標籤是不是本尊本身」，而不是同領域的其他子類別/品牌），`pickSeed_` 挑 `closeness` 最高的那個。例如搜「慢跑鞋」查無此標籤本身時，會挑「慢跑」（幾乎同義的活動）而不是「跑步機」（同領域但明顯是別的東西）。

**這是第二版設計，第一版（挑「受眾規模最小」的）已廢棄**：早期以為「規模小 = 具體 = 有意義的錨點」，但規模小跟語意接近沒有必然關係，實測時就出現過搜「慢跑鞋」挑到「阿姆斯特丹馬拉松」這種語意上很偏門、但剛好受眾規模最小的標籤當種子，比對出來的重疊結果自然沒有參考價值。第一版的動機（避免挑到「健身和保健（健身）」這種籠統大分類）用 closeness 排序也能自然避開，因為大分類的 closeness 通常會被 AI 判得比較低（它是「同領域但不是本尊」的典型情況）。

只有在完全沒有 `closeness` 資料時（理論上只會發生在 AI 分類整個失敗、退回保守 fallback 的情況——那種情況下 `directResults` 通常已經只剩下精準同名這一筆，走不到這裡）才退回舊的「受眾規模最小」heuristic 當最後防線。

`pickSeed_` 回傳 `{item, reason}`，`reason` 會透過 `startOverlapScan_`/`getOverlapScanStatus_`（`Overlap.gs`）的 `seedReason` 欄位一路傳到前端，`docs/app.js` 的 `renderSeedInfo_()` 顯示在③受眾重疊比對區塊一個**不會被輪詢進度或錯誤訊息蓋掉的固定位置**（`#overlap-seed-info`）——種子選誰，常常就是比對結果落差的原因，所以特別交代清楚。

### `lift` 指標 vs `overlap_ratio`

`overlap_ratio`（交集/min(A,B)）天生偏袒大受眾標籤。第三類排序改用 `lift = 交集 ÷ (A規模×B規模÷母體總數)`，才是真正在找「意外關聯」的訊號，而不是「兩個都很大眾所以交集也很大」的假訊號。`overlap_ratio` 本身也已夾在 0~1 之間（`Math.min(1, ...)`）——Meta 的 `delivery_estimate` 是抽樣估算不是精確集合運算，兩個高度重疊的標籤偶爾會估出超過 100% 的交集，夾在 0~1 是修正這個。**注意：`OverlapCache` 裡這次修正之前的舊快取資料可能還殘留超過 100% 的髒值**，命中快取不會重算，需要的話手動去該分頁清掉異常列。

### Gemini 免費額度：模型 × 金鑰的優先序容錯鏈

`GEMINI_API_KEY` 免費方案的額度限制是**每個模型分開算，每天 20 次**（`quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier`），不同模型的額度互相獨立（例如 Flash Lite 系列可以到 500 RPD）。`GeminiClient.gs` 的容錯邏輯：

- `GEMINI_MODEL_PRIORITY`：模型清單依智慧程度排序（Pro > Flash > Flash Lite，數字越大越新）。
- `getGeminiApiKeys_()`：讀取所有已設定的 `GEMINI_API_KEY*` 屬性。
- `callGemini_()`：雙層迴圈，外層跑模型優先序、內層跑所有金鑰——**確保兩支金鑰的最強模型都試過，才會降級用次強模型**（模型優先、金鑰其次）。
- `callGeminiOnce_()`：單一模型+金鑰組合的呼叫。命中 HTTP 429 直接放棄不重試（Google 實際要求的重試間隔是幾十秒起跳，內部原本幾百毫秒的重試沒有意義還浪費額度）；其他錯誤才走原本的重試邏輯。

**2026-09-08 修正：`GEMINI_MODEL_PRIORITY` 舊清單有一半根本打不通。** 使用者反應「額度消耗特別快」，用暫時的除錯端點直接測每一組模型+金鑰（bypass `callGemini_` 的 fallback 邏輯，一組一組單獨打）才發現：舊清單 6 個模型裡，`gemini-3.1-pro`、`gemini-3-flash` 是照命名慣例猜的，**根本不存在**（打下去 404）；`gemini-2.5-pro` 雖然在 `ListModels` 列得出來，但這把金鑰打下去也是 404「不再開放給新用戶」。等於每次呼叫都要先白白浪費兩次（每個死模型的請求還會照 `GEMINI_CALL_ATTEMPTS` 重試一次）注定失敗的請求，才會走到真正能用的模型——這正是「額度消耗快」+「搜尋常要等 40~130 秒」的主因之一：能真正分攤負載的模型其實只有原本清單的一半（`gemini-2.5-flash`／`gemini-3.1-flash-lite`／`gemini-2.5-flash-lite` 這三個是真的）。

現在的清單改成用同一把金鑰實測過（先打 `GET /v1beta/models` 拿真實清單，再逐一 `generateContent` 探測）、**確認會回 200** 的模型名字：`gemini-pro-latest`、`gemini-3-flash-preview`、`gemini-flash-latest`、`gemini-3.5-flash`、`gemini-3.1-flash-lite-preview`、`gemini-3.5-flash-lite`、`gemini-3.1-flash-lite`、`gemini-flash-lite-latest`、`gemini-2.5-flash`、`gemini-2.5-flash-lite`——同一次測試裡有 8~9 個回 200（只有 `gemini-pro-latest` 因為免費方案本來就沒額度、回 429 是預期中的）。`gemini-*-latest` 是 Google 提供的別名，會自動指向該層級目前最新的正式模型，以後 Google 換版本不用回來改清單，但**這幾個別名底層實際對應到哪個模型、額度是不是跟旁邊列出的具體模型共用同一個配額桶，沒有進一步驗證過**——如果之後發現某個別名總是跟緊接在它旁邊的具體模型同時 429，很可能是共用同一桶，可以考慮拿掉其中一個。

**如果之後 Google 又出新模型或改了命名，不要再憑猜的加進 `GEMINI_MODEL_PRIORITY`**——照上面的方法（暫時加一個 debug 端點直接測，見「已知的環境/工具怪癖」最後一條）先確認真的能用再加，猜錯的名字看起來像多一層保險，實際上只是每次都白白拖慢速度。

真正的治本方法還是使用者自己去 [Google AI Studio](https://aistudio.google.com/apikey) 把金鑰所在專案升級成付費方案（這種用量一天大概幾毛錢），或至少把 `GEMINI_API_KEY_2` 的佔位值換成真的第二把金鑰——模型清單修好只是讓「同樣的免費額度」不再有一半被浪費在打不通的死模型上，不是讓總額度變多。

### AI 分類的機率性誤差（已知限制，不是 bug）

`classifyAndTierResults_` 的 prompt 已經補強兩輪（抽象規則 + 具體案例，例：Hyrox 這種混合健身競賽該判「CrossFit Training/高強度間歇訓練」為 direct、「露營/園藝/旅遊創作者」為 indirect），實測「CrossFit」效果很好，但同一 prompt 重測「Hyrox」偶爾還是會把同領域外的項目誤判成 direct——**這是 AI 分類本身固有的機率性誤差，不會是 100% 穩定**，如果之後常常反應這個問題，可以考慮加更多案例或換更強的模型。

### classifyAndTierResults_ 整個失敗時的退化行為（2026-09-08 修正）

實測「童顏針」（一個 Meta 標籤庫沒有直接對應標籤的醫美詞彙）時，直接相關混進「蒂芙尼公司（精品）」「戲劇演員」「職業高爾夫球手」這類完全不相關的雜訊，而且被標成「高關聯度」的間接相關。**用暫時的除錯端點（`debugUnifiedClassify_`，已排查完刪除，做法見下面「已知的環境/工具怪癖」最後一條）直接比對輸入輸出，證實不是分類判斷錯誤，是 `classifyAndTierResults_` 整個 Gemini 呼叫失敗（額度用完），命中了舊版的 fallback：把候選詞清單全部標成 `bucket='direct'`**（也就是把 Meta 對查無精準匹配字詞補位回來的熱門雜訊，原封不動當「直接相關」端出來），這比不顯示還糟糕。

**修法**：
- fallback 改成保守退回——只有跟搜尋詞完全同名的那筆留著當 direct，其餘全部標成 `unrelated`（排除），每筆都標記 `aiFailed: true`。
- `handleUnifiedSearch_`（`UnifiedSearch.gs`）偵測到 `aiFailed` 時，在回傳結果裡加一個 `aiClassificationFailed: true` 欄位。
- 前端（`docs/app.js` 的 `showAiDegradedWarning_()`）看到這個欄位會顯示一個明確的黃色警告橫幅，講清楚「AI 關聯性複查暫時無法使用（很可能是額度用完），這次的直接相關只保留完全同名的結果、間接相關這次沒有輸出」——**不能讓退化結果看起來像正常結果**，這是這次修正最重要的原則。

這個修正只是讓「額度用完」這個已知問題**表現得誠實**（清楚告訴使用者發生了什麼、不要展示誤導性的雜訊），沒有解決額度問題本身——治本還是要看上面「Gemini 免費額度」那一節，換真的第二把金鑰或開通付費額度。

### 「AI 全部失敗」不一定是額度用完——每分鐘上限也會被同時打滿（2026-09-09 修正）

使用者回報：明明 Google AI Studio 的額度儀表板顯示各模型當天額度都還沒用滿，搜尋卻還是命中「AI 關聯性複查暫時無法使用」的退化分支。**用暫時的除錯端點直接重跑一次一模一樣的兩次 Gemini 呼叫（帶完整 per-attempt trace，不再只看 Apps Script 網頁介面那個常常點不開的「執行記錄」）**，發現同一個查詢幾秒後重打，第一個候選模型就直接成功——證實不是模型真的掛了，是**當下那一刻剛好全部模型都在同一分鐘內失敗**。

根因：Gemini 免費方案除了每天的總量上限（RPD，額度儀表板看得到），**還有「每分鐘」上限**（很多模型只有 2~5 次/分鐘，比 RPD 嚴格得多，儀表板不會特別凸顯）。而 `docs/app.js` 原本完全沒有防止重複送出搜尋——單次搜尋常要等 40~130 秒，使用者等不及重複點搜尋按鈕、或連續換關鍵字查很正常，但這樣會讓好幾次搜尋的 Gemini 呼叫疊進同一分鐘，即使當天總額度還很充裕，也可能把好幾個模型的「每分鐘」上限同時打滿，表現出來就像「AI 全部失敗」。

**修法**：`docs/app.js` 加了 `state.searchInFlight` 旗標，`runUnifiedSearch()` 在還有搜尋跑在背景時直接忽略新的呼叫，並把搜尋按鈕 disable 到這次搜尋結束（成功或失敗都會恢復）——確保同一個瀏覽器分頁裡最多只有一次搜尋的 Gemini 呼叫在跑。**這只解決「同一個人重複點擊」這個最常見的觸發情境**，如果之後開放給多人同時使用，不同使用者的搜尋還是可能疊加撞到同一把金鑰的每分鐘上限，這個情境目前沒有處理（跟 `OVERLAP_SCAN_STATE` 那個全域單一狀態的取捨類似，小範圍分享先不管，擴大規模前要重新設計）。

## 已知的環境/工具怪癖

- **Apps Script 編輯器的下拉選單常常要點兩次**：第一次點擊經常只是把選單「叫出來」但沒有真的選中項目，第二次點同一個座標才會生效。UI 沒反應先截圖確認選單是否真的開著。
- **Apps Script 頂端工具列的函式下拉選單只顯示目前開啟中的檔案裡的函式**，不是專案全部函式。要跑某個函式，得先點開該函式所在的檔案。
- **Google Sheets 的自動化打字（模擬鍵盤 `type`）連續打很多行會不可預期漏字**：可靠做法是先用公式一次性展開，再整個範圍複製、貼上「僅貼上值」轉成純值。
- **持續（不是偶發）404**：曾經整個部署本身壞掉（後端執行紀錄顯示正常跑完，但 `/exec` 一直回 Google 自己的 404），直接建全新部署解決，不要浪費時間排查。
- **懷疑後端某個資料處理環節出問題（例如懷疑分類/AI 判斷跟預期不符）時，Apps Script 網頁介面的「執行記錄」很難用**（點進去要點很多次、常常點不開詳細 log）。比較快的做法：暫時在 `Code.gs` 的 `doGet` 加一個 debug action（例如 `debugXxx`），直接把中間步驟的原始資料原封不動用 `jsonOutput_` 吐回來，用 `curl` 直接打就能肉眼比對——**排查完一定要把暫時加的 debug action 和對應函式刪乾淨，用 `git diff`／`git status` 確認乾淨後才 commit**，不要留在正式版本裡。

## 部署與代碼交付原則

- **後端邏輯改動一律用 `clasp push` 推送**，不要在線上編輯器貼長段程式碼。
- **`clasp push` 之後要 `clasp deploy -i <既有 deploymentId>` 才會讓 `/exec` 網址生效**（單純 push 只更新草稿），且部署完別忘了修「誰可以存取」（見上面）。
- **不要替使用者輸入實際密鑰值**：新增 Script Property 時只新增名稱，值留給使用者自己貼進 Apps Script UI。

## 還沒做的事 / 建議的下一步

1. **候選池上限與批次大小**（`UnifiedSearch.gs` 的 `OVERLAP_CANDIDATE_POOL_LIMIT`、`Overlap.gs` 的 `OVERLAP_SCAN_BATCH_SIZE`）目前是保守值（40 筆候選池、每批 6 筆、約 5~7 分鐘跑完一次第三類掃描），還沒實測 Meta `delivery_estimate` 真正的限速上限，調大之前建議先測。
2. **`OverlapCache` 舊資料清理**：修正 `overlap_ratio` 超過 100% 的 bug 之前，快取裡可能還留著髒值，目前沒有自動化清理，需要的話手動去該分頁清。
3. **Gemini 額度**：已加上模型 × 金鑰容錯鏈，`GEMINI_MODEL_PRIORITY` 也已經逐一實測過真的能用（見上面 2026-09-08 那次修正），但 (a) `GEMINI_API_KEY_2` 還是佔位值，需要使用者換成真的金鑰——這是目前唯一還沒解決、真正會限制總額度的部分；(b) 長期看還是建議評估開通付費額度；(c) `gemini-*-latest` 別名跟清單裡其他具體模型是否共用配額桶沒驗證過，之後如果懷疑，可以用同樣的暫時 debug 端點手法直接測。
4. **AI 分類邊界的機率性誤差**：見上面「已知限制」，如果之後常態性出現分類錯誤，可以加更多 few-shot 案例或考慮換模型。
5. **第三類重疊掃描是全域單一狀態**（`OVERLAP_SCAN_STATE`，`Overlap.gs`）：兩個人同時搜尋，後發起的會蓋掉前一個的進度。小範圍分享這個取捨可以接受，但擴大使用規模前要重新設計（例如帶 session id）。
6. **`closeness` 分數的品質沒有大量驗證過**：目前只用「慢跑鞋」「童顏針」這幾個詞測過，AI 打分是否真的穩定拉開差距（而不是每筆都給差不多的分數），還需要更多實測案例觀察。
7. **AI 分類整個失敗時，間接相關（②）目前是直接沒有輸出**（因為 fallback 只處理了 direct/unrelated 的判斷，沒有嘗試從候選詞來源猜間接相關）——這是刻意選擇「保守但誠實」而不是「生成更多但可能有雜訊的猜測」，如果之後覺得使用者體驗上更想要「有猜測總比沒有好」，可以重新考慮這個取捨。
8. **Gemini 每分鐘上限只處理了單一瀏覽器分頁重複點擊的情境**（見上面 2026-09-09 那次修正）：如果之後開放給多人同時用，不同人的搜尋還是可能疊加撞到同一把金鑰的每分鐘上限，導致明明看起來額度充裕卻集體失敗——擴大使用規模前要重新設計（例如後端排隊、或每次呼叫間隔開）。

## 相關文件

- `README.md`：完整設定步驟，從建 Sheet 到部署都寫了。
- `~/.claude/plans/logical-jingling-river.md`、`~/.claude/plans/floofy-jumping-owl.md`：原始規劃文件（本機路徑，只在特定機器上看得到）。
