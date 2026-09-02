# Meta 興趣受眾探索工具

用 Meta Marketing API 系統化枚舉目前實際開放的興趣標籤、找關聯興趣、估算重疊度，取代「憑印象亂猜關鍵字」的受眾發想方式。詳細設計脈絡見 [計畫文件](https://github.com/)（本機路徑：`~/.claude/plans/logical-jingling-river.md`）。

架構：**Google Sheets（資料庫）+ Google Apps Script（後端 Web App）+ 純 HTML/JS 前端（GitHub Pages）**。全程不需要 GCP 帳單帳戶。

## 第一次設定

### 1. 建立資料庫 Sheet

開一個新的 Google Sheet，隨便命名（例如「Meta興趣資料庫」）。不用手動建分頁，程式第一次寫入時會自動建好 `Interests` / `Categories` / `Snapshots` / `RelatedCache` / `OverlapCache` 五個分頁。

⚠️ **這份 Sheet 之後不要分享編輯權限給任何人**——它綁定的 Apps Script 專案裡存著 Meta token 等機密（見下方第 3 步），只要誰有這份 Sheet 的「編輯者」權限，就能打開「擴充功能 > Apps Script > 專案設定」看到明文，這是 Google 的權限模型本身如此，Sheet 內的「保護工作表/範圍」功能救不了這件事。之後要分享這個工具給同事，只分享**前端網頁的網址**（第 5 步），不要分享這份 Sheet 本身。

### 1b. 建立另一份「種子關鍵字」Sheet（這份可以放心分享）

再開**另一個獨立的**新 Google Sheet（例如「Meta興趣發想—種子關鍵字清單（可共編）」），建一個 `SeedKeywords` 分頁，A 欄從第 2 列開始，一列填一個關鍵字（第 1 列留給表頭 `keyword`）。這是刷新快照時拿去搜尋興趣用的種子關鍵字，涵蓋越多常見分類（3C、美妝、旅遊、健身、親子、遊戲、金融、時尚、寵物、美食…）效果越好。

把這份 Sheet 的網址列裡那串 ID（`https://docs.google.com/spreadsheets/d/{這一段}/edit`）記下來，第 3 步要用到。之所以刻意拆成兩份 Sheet：這份完全不含任何機密，之後同事想幫忙補充關鍵字，直接把這份 Sheet 的編輯權限分享給他們即可，不會連帶洩漏 Meta token。

### 2. 部署 Apps Script

在這個 Sheet 裡「擴充功能 > Apps Script」，把 `apps-script/` 目錄下的 5 個檔案（`Code.gs`、`MetaClient.gs`、`Overlap.gs`、`SheetsStore.gs`、`appsscript.json`）內容貼進對應檔案（`appsscript.json` 要切到「專案設定 > 顯示 appsscript.json」才看得到）。

或者用 [`clasp`](https://github.com/google/clasp)（推薦，才能像其他專案一樣版本控制）：

```bash
npm install -g @google/clasp
clasp login
```

把 `apps-script/.clasp.json.example` 複製成 `apps-script/.clasp.json`，填入你剛剛那個 Sheet 綁定的 Apps Script 專案 ID（Apps Script 編輯器右上角「專案設定」裡可以找到），然後：

```bash
cd apps-script
clasp push
```

### 3. 填入憑證

⚠️ **不要用 `setup()` 函式**（程式碼裡還留著，但已知有問題）：它用 `ui.prompt()` 依序跳三個輸入框，而 Apps Script 單次執行的 6 分鐘上限包含「等你輸入」的時間——填三個框如果超過 6 分鐘，程式會在存值之前就被系統砍掉，三個值全部不會存進去（親身遇過）。

改成直接在「專案設定 > 指令碼屬性」手動新增四筆，沒有時間壓力：

| 屬性名稱 | 值 |
|---|---|
| `META_ACCESS_TOKEN` | Meta access token（沿用 `meta-ads-mcp-server` 裡 FAV 或 Freedom 帳戶的 token，**記得先加開 `ads_management` 權限**，重疊估算的 `delivery_estimate` 需要它） |
| `META_AD_ACCOUNT_ID` | 廣告帳戶 ID，`act_` 前綴加不加都可以，程式碼會自動處理 |
| `APP_API_KEY` | 自己取一組隨機字串，用來保護「算重疊」「刷新快照」這兩個會花 API 額度的操作 |
| `SEED_KEYWORDS_SHEET_ID` | 第 1b 步那份**另外一份**種子關鍵字 Sheet 的檔案 ID |

這些值存在 Apps Script 的 Script Properties 裡，不會出現在程式碼或 git 裡——但要注意：**任何有這份「資料庫」Sheet 編輯權限的人，都看得到這個頁面的明文值**（見第 1 步的警語），所以這份 Sheet 的編輯權限要一直只留給你自己。

### 4. 部署成 Web App

Apps Script 編輯器右上角「部署 > 新增部署作業 > 網頁應用程式」：
- 執行身分：我
- 誰能存取：所有人（v1 先不設限制；之後要收緊給同事用，改這裡就好，不用重寫程式）

部署完會拿到一個 Web App URL，長得像 `https://script.google.com/macros/s/xxxx/exec`。

### 5. 部署前端

`web/` 目錄下三個檔案（純靜態，沒有 build step）直接推到一個 GitHub repo，開啟 GitHub Pages 指向這個 repo 即可。或是先在本機直接用瀏覽器開 `web/index.html` 測試也可以。

打開頁面後，把第 4 步拿到的 Web App URL、跟你在 `setup()` 裡設的 `apiKey` 貼進頁面最上面兩個欄位，按「儲存設定」。

## 日常使用

1. **搜尋 / 瀏覽興趣**：左邊分類、中間搜尋框，點結果加進右邊「工作清單」
2. **找相關**：工作清單裡每個興趣卡片按「找相關」，會呼叫 `adinterestsuggestion` 找 Meta 認為關聯的其他興趣，補進中間的建議清單
3. **算重疊**：工作清單選 2 個以上興趣，按「算重疊」，跑一下會出現色階矩陣，顏色越紅代表這兩個興趣的受眾重疊比例越高，代表疊用意義不大
4. **複製給 AI**：按「複製給 AI」，會把整個工作清單格式化成一段文字複製到剪貼簿，直接貼去 Claude / ChatGPT 對話裡繼續發想

## 刷新快照（建議每季跑一次）

在 Apps Script 編輯器裡執行 `startOrContinueRefresh_`，或用任何工具對 Web App URL 發一個 POST：

```json
{ "action": "refreshSnapshot", "apiKey": "你的 apiKey" }
```

因為 Apps Script 單次執行有 6 分鐘上限，關鍵字多的話會自動分批、每批中間排一個 1 分鐘後的觸發器接續執行，整個跑完可能要幾分鐘到十幾分鐘，過程中可以用 `?action=refreshStatus` 查目前進度。跑完後 `Snapshots` 分頁會多一列，裡面的 `removed_interest_ids` 就是「上次還在、這次消失了」的興趣 ID 清單。

## 已知限制（v1 刻意先不做的事）

- 沒有登入限制，Web App 部署設定是「所有人」都能打——網址不公開視為足夠，要分享給同事前記得先收緊
- 沒有排程自動刷新，要自己手動觸發（Apps Script 的時間驅動觸發器可以之後直接加，免費）
- 沒有包成 MCP 工具，目前只能透過網頁用，之後如果想直接在 Claude 對話裡查，可以另外包一層轉接
