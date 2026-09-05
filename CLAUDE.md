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

- **Public repo**（`https://github.com/mattliverpoolfan/meta-interest-explorer`，[live 前端](https://mattliverpoolfan.github.io/meta-interest-explorer/)）：GitHub Pages 靠這個 repo 是 public 才能免費跑（private repo 要 GitHub Pro/Team/Enterprise 才能開 Pages）。**先維持原樣、不要再往這裡 push**，除非之後確認要不要繼續同步。
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

### 種子標籤選擇：優先受眾規模最小的，不是「第一筆」

`pickSeed_`（`UnifiedSearch.gs`）：直接相關裡跟原字詞完全同名的優先當種子；沒有精準對應時，**不能**選「清單第一筆」——這樣容易選到 Meta 分類樹最上層的籠統大分類（例如「健身和保健（健身）」，全球受眾 10 億+）。這種大分類拿去跟自己的子分類配對算重疊，Meta `delivery_estimate` 會直接回傳兩邊受眾都是 0（已用 `estimateOverlap` 實測證實：父分類 vs 自己子分類的組合，Meta 判定為冗餘/無效定向）。改成挑直接相關裡「受眾規模最小」的當種子，越具體越小眾的標籤，越不可能是別人的父分類，也是比對重疊時真正有意義的錨點。

### `lift` 指標 vs `overlap_ratio`

`overlap_ratio`（交集/min(A,B)）天生偏袒大受眾標籤。第三類排序改用 `lift = 交集 ÷ (A規模×B規模÷母體總數)`，才是真正在找「意外關聯」的訊號，而不是「兩個都很大眾所以交集也很大」的假訊號。`overlap_ratio` 本身也已夾在 0~1 之間（`Math.min(1, ...)`）——Meta 的 `delivery_estimate` 是抽樣估算不是精確集合運算，兩個高度重疊的標籤偶爾會估出超過 100% 的交集，夾在 0~1 是修正這個。**注意：`OverlapCache` 裡這次修正之前的舊快取資料可能還殘留超過 100% 的髒值**，命中快取不會重算，需要的話手動去該分頁清掉異常列。

### Gemini 免費額度：模型 × 金鑰的優先序容錯鏈

`GEMINI_API_KEY` 免費方案的額度限制是**每個模型分開算，每天 20 次**（`quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier`），不同模型的額度互相獨立（例如 Flash Lite 系列可以到 500 RPD）。`GeminiClient.gs` 的容錯邏輯：

- `GEMINI_MODEL_PRIORITY`：模型清單依智慧程度排序（Pro > Flash > Flash Lite，數字越大越新）。**這個排序是照 Google 命名慣例推測的，沒有逐一實測驗證過**，如果發現排序不合理，直接調整陣列順序即可，不用動其他程式碼。
- `getGeminiApiKeys_()`：讀取所有已設定的 `GEMINI_API_KEY*` 屬性。
- `callGemini_()`：雙層迴圈，外層跑模型優先序、內層跑所有金鑰——**確保兩支金鑰的最強模型都試過，才會降級用次強模型**（模型優先、金鑰其次）。
- `callGeminiOnce_()`：單一模型+金鑰組合的呼叫。命中 HTTP 429 直接放棄不重試（Google 實際要求的重試間隔是幾十秒起跳，內部原本幾百毫秒的重試沒有意義還浪費額度）；其他錯誤才走原本的重試邏輯。

這只是緩解，沒有根治——真正解法是使用者自己去 [Google AI Studio](https://aistudio.google.com/apikey) 把金鑰所在專案升級成付費方案（這種用量一天大概幾毛錢），或至少把 `GEMINI_API_KEY_2` 的佔位值換成真的第二把金鑰。

### AI 分類的機率性誤差（已知限制，不是 bug）

`classifyAndTierResults_` 的 prompt 已經補強兩輪（抽象規則 + 具體案例，例：Hyrox 這種混合健身競賽該判「CrossFit Training/高強度間歇訓練」為 direct、「露營/園藝/旅遊創作者」為 indirect），實測「CrossFit」效果很好，但同一 prompt 重測「Hyrox」偶爾還是會把同領域外的項目誤判成 direct——**這是 AI 分類本身固有的機率性誤差，不會是 100% 穩定**，如果之後常常反應這個問題，可以考慮加更多案例或換更強的模型。

## 已知的環境/工具怪癖

- **Apps Script 編輯器的下拉選單常常要點兩次**：第一次點擊經常只是把選單「叫出來」但沒有真的選中項目，第二次點同一個座標才會生效。UI 沒反應先截圖確認選單是否真的開著。
- **Apps Script 頂端工具列的函式下拉選單只顯示目前開啟中的檔案裡的函式**，不是專案全部函式。要跑某個函式，得先點開該函式所在的檔案。
- **Google Sheets 的自動化打字（模擬鍵盤 `type`）連續打很多行會不可預期漏字**：可靠做法是先用公式一次性展開，再整個範圍複製、貼上「僅貼上值」轉成純值。
- **持續（不是偶發）404**：曾經整個部署本身壞掉（後端執行紀錄顯示正常跑完，但 `/exec` 一直回 Google 自己的 404），直接建全新部署解決，不要浪費時間排查。

## 部署與代碼交付原則

- **後端邏輯改動一律用 `clasp push` 推送**，不要在線上編輯器貼長段程式碼。
- **`clasp push` 之後要 `clasp deploy -i <既有 deploymentId>` 才會讓 `/exec` 網址生效**（單純 push 只更新草稿），且部署完別忘了修「誰可以存取」（見上面）。
- **不要替使用者輸入實際密鑰值**：新增 Script Property 時只新增名稱，值留給使用者自己貼進 Apps Script UI。

## 還沒做的事 / 建議的下一步

1. **候選池上限與批次大小**（`UnifiedSearch.gs` 的 `OVERLAP_CANDIDATE_POOL_LIMIT`、`Overlap.gs` 的 `OVERLAP_SCAN_BATCH_SIZE`）目前是保守值（40 筆候選池、每批 6 筆、約 5~7 分鐘跑完一次第三類掃描），還沒實測 Meta `delivery_estimate` 真正的限速上限，調大之前建議先測。
2. **`OverlapCache` 舊資料清理**：修正 `overlap_ratio` 超過 100% 的 bug 之前，快取裡可能還留著髒值，目前沒有自動化清理，需要的話手動去該分頁清。
3. **Gemini 額度**：已加上模型 × 金鑰容錯鏈，但 (a) `GEMINI_API_KEY_2` 還是佔位值，需要使用者換成真的金鑰；(b) `GEMINI_MODEL_PRIORITY` 的排序沒有逐一實測驗證過；(c) 長期看還是建議評估開通付費額度。
4. **AI 分類邊界的機率性誤差**：見上面「已知限制」，如果之後常態性出現分類錯誤，可以加更多 few-shot 案例或考慮換模型。
5. **第三類重疊掃描是全域單一狀態**（`OVERLAP_SCAN_STATE`，`Overlap.gs`）：兩個人同時搜尋，後發起的會蓋掉前一個的進度。小範圍分享這個取捨可以接受，但擴大使用規模前要重新設計（例如帶 session id）。

## 相關文件

- `README.md`：完整設定步驟，從建 Sheet 到部署都寫了。
- `~/.claude/plans/logical-jingling-river.md`、`~/.claude/plans/floofy-jumping-owl.md`：原始規劃文件（本機路徑，只在特定機器上看得到）。
