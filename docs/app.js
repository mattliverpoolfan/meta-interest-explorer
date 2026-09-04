// 極簡 vanilla JS，沒有框架、沒有 build step，直接開 index.html 或丟 GitHub Pages 就能跑。

// Web App 網址是固定的，寫死在這裡就好，不需要使用者自己貼；
// apiKey 則從分享連結的 ?key= 參數自動帶入（見 init() 底部），不做成畫面上的輸入框。
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxsLaM_z7wYqkJPfAVa0A6fWhbH7fyoQHMHTmmOK3Ra-ts7xJZnpyjTtVOCvV9737J4/exec';

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
  overlapPollTimer: null,
};

const el = (id) => document.getElementById(id);

function init() {
  // 分享連結帶 ?key=xxx 時，把 apiKey 存起來並把它從網址上拿掉（避免留在瀏覽器紀錄/分享截圖裡）
  const params = new URLSearchParams(location.search);
  const keyFromUrl = params.get('key');
  if (keyFromUrl) {
    state.apiKey = keyFromUrl;
    localStorage.setItem('apiKey', keyFromUrl);
    params.delete('key');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
  }

  el('search-btn').addEventListener('click', runUnifiedSearch);
  el('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runUnifiedSearch(); });
  el('manual-compare-btn').addEventListener('click', computeManualOverlap);
  initTabs();

  loadCategories();
}

// 探索/檢索跟自行比對是兩個獨立情境，不是同一套流程的前後步驟——用分頁切換，
// 同時只顯示一個，避免版面看起來像「往下做完一步接著做下一步」。
function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tabpanel').forEach((panel) => {
        panel.hidden = panel.dataset.tabpanel !== btn.dataset.tab;
      });
    });
  });
}

/**
 * Apps Script 的 /exec 端點會間歇性回傳 Google 自己的 404 錯誤頁（HTML，不是我們的 JSON）——
 * 後端執行紀錄顯示程式其實有正常跑完，是 Google 的傳遞層在出包，而且過幾分鐘會自己好。
 * 這種上游不穩定我們沒辦法從程式碼修掉，只能重試把它蓋過去。
 */
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonWithRetry(url, options) {
  let lastProblem = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        // 拿到 HTML 而不是 JSON＝Google 傳遞層出包，值得重試
        lastProblem = `Google 回應異常（HTTP ${res.status}）`;
      }
    } catch (networkErr) {
      lastProblem = networkErr.message;
    }
    if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
  }
  throw new Error(`${lastProblem}，重試 ${RETRY_ATTEMPTS} 次都失敗。這是 Google Apps Script 端的間歇性問題，通常過幾分鐘會自己恢復，請稍後再試。`);
}

async function apiGet(action, params) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const json = await fetchJsonWithRetry(`${WEBAPP_URL}?${qs}`);
  if (json.error) throw new Error(json.error);
  return json;
}

async function apiPost(body) {
  const json = await fetchJsonWithRetry(WEBAPP_URL, {
    method: 'POST',
    // 用 text/plain 避免瀏覽器對 Apps Script Web App 發出 CORS preflight（Apps Script 對 OPTIONS 的支援不完整）
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, apiKey: state.apiKey }),
  });
  if (json.error) throw new Error(json.error);
  return json;
}

async function loadCategories() {
  try {
    const categories = await apiGet('categoryTree', {});
    const list = el('category-list');
    list.innerHTML = '';
    categories.slice(0, 300).forEach((c) => {
      const li = document.createElement('li');
      li.textContent = c.name;
      li.title = safeParsePath(c.path).join(' > ');
      li.addEventListener('click', () => {
        el('search-input').value = c.name;
        runUnifiedSearch();
      });
      list.appendChild(li);
    });
  } catch (e) {
    console.error(e);
  }
}

function safeParsePath(path) {
  if (Array.isArray(path)) return path;
  try { return JSON.parse(path || '[]'); } catch (e) { return []; }
}

const OVERLAP_POLL_INTERVAL_MS = 3000;

// 一次搜尋、三類結果同時呈現：直接相關/邏輯間接相關同步查完直接回傳，
// 受眾重疊比對（第三類）另外交給後端非同步跑，這裡只負責啟動輪詢。
async function runUnifiedSearch() {
  const q = el('search-input').value.trim();
  const statusEl = el('search-status');
  if (!q) return;

  stopOverlapPolling_();
  statusEl.textContent = '搜尋中（AI 聯想候選詞 + 逐一向 Meta 驗證，會需要幾秒）…';
  statusEl.classList.remove('error');
  renderResultList(el('direct-results'), []);
  renderResultList(el('indirect-results'), []);
  el('overlap-scan-progress').textContent = '';
  renderOverlapScanResults([]);

  try {
    const { direct, indirect, overlapScan } = await apiPost({ action: 'unifiedSearch', query: q });
    renderResultList(el('direct-results'), direct);
    renderResultList(el('indirect-results'), indirect);
    statusEl.textContent = `直接相關 ${direct.length} 筆、間接相關 ${indirect.length} 筆`;

    if (overlapScan) {
      el('overlap-scan-progress').textContent = `以「${overlapScan.seedName}」為種子，比對中… 0/${overlapScan.total}`;
      pollOverlapScan(overlapScan.scanId);
    } else {
      el('overlap-scan-progress').textContent = '找不到可以當比對種子的直接相關標籤，這次搜尋沒有第三類結果';
    }
  } catch (e) {
    statusEl.textContent = '錯誤：' + e.message;
    statusEl.classList.add('error');
  }
}

function renderResultList(listEl, items) {
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<li class="empty">（沒有結果）</li>';
    return;
  }
  items.forEach((item) => {
    const li = document.createElement('li');
    const pathText = safeParsePath(item.path).join(' > ');
    li.innerHTML = `<span class="name">${item.name}</span>` + (pathText ? `<span class="path">${pathText}</span>` : '');
    listEl.appendChild(li);
  });
}

function stopOverlapPolling_() {
  if (state.overlapPollTimer) {
    clearTimeout(state.overlapPollTimer);
    state.overlapPollTimer = null;
  }
}

function pollOverlapScan(scanId) {
  const tick = async () => {
    try {
      const status = await apiGet('overlapScanStatus', { scanId });
      if (status.replaced) {
        el('overlap-scan-progress').textContent = '這個比對已經被之後的新搜尋取代，這次搜尋就不會有第三類結果了';
        return;
      }
      el('overlap-scan-progress').textContent = `以「${status.seedName}」為種子，比對中… ${status.done}/${status.total}`;
      renderOverlapScanResults(status.results);
      if (status.running) {
        state.overlapPollTimer = setTimeout(tick, OVERLAP_POLL_INTERVAL_MS);
      } else {
        el('overlap-scan-progress').textContent = `以「${status.seedName}」為種子，比對完成（共 ${status.total} 筆）`;
      }
    } catch (e) {
      el('overlap-scan-progress').textContent = '比對進度查詢失敗：' + e.message;
    }
  };
  tick();
}

function renderOverlapScanResults(results) {
  const listEl = el('overlap-scan-results');
  listEl.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    const ratioText = (r.overlap_ratio * 100).toFixed(0) + '%';
    const liftText = r.lift != null ? `lift ${r.lift.toFixed(1)}×` : '';
    li.innerHTML = `<span class="name">${r.name}</span><span class="path">重疊率 ${ratioText}　${liftText}</span>`;
    listEl.appendChild(li);
  });
}

// items: [{id, name}]，跟 manual-compare 分頁共用同一個畫表格函式
function renderOverlapMatrix(table, items, results) {
  const idToName = Object.fromEntries(items.map((w) => [String(w.id), w.name]));
  const ratioByPair = {};
  results.forEach((r) => {
    ratioByPair[pairKey(r.interest_a, r.interest_b)] = r.overlap_ratio;
  });

  const ids = items.map((w) => w.id);
  let html = '<tr><th></th>' + ids.map((id) => `<th>${idToName[id]}</th>`).join('') + '</tr>';
  ids.forEach((rowId) => {
    html += `<tr><th>${idToName[rowId]}</th>`;
    ids.forEach((colId) => {
      if (rowId === colId) {
        html += '<td>—</td>';
      } else {
        const ratio = ratioByPair[pairKey(rowId, colId)];
        html += `<td style="background:${ratioToColor(ratio)}">${ratio != null ? (ratio * 100).toFixed(0) + '%' : '?'}</td>`;
      }
    });
    html += '</tr>';
  });
  table.innerHTML = html;
  table.style.display = 'table';
}

const MANUAL_COMPARE_MIN = 2;
const MANUAL_COMPARE_MAX = 5;

// 跟上面「一次搜尋三類結果」完全獨立：使用者直接打字給名稱，
// 這裡才去反查對應的 Meta 興趣 id，不需要先經過搜尋結果點選的流程。
async function resolveInterestByName_(name) {
  const results = await apiGet('searchInterests', { q: name });
  if (!results.length) throw new Error(`找不到「${name}」`);
  const exact = results.find((r) => r.name.trim() === name.trim());
  const picked = exact || results[0];
  return { id: picked.id, name: picked.name };
}

async function computeManualOverlap() {
  const statusEl = el('manual-compare-status');
  const names = Array.from(document.querySelectorAll('.manual-compare-input'))
    .map((input) => input.value.trim())
    .filter(Boolean);

  if (names.length < MANUAL_COMPARE_MIN || names.length > MANUAL_COMPARE_MAX) {
    statusEl.textContent = `請輸入 ${MANUAL_COMPARE_MIN}～${MANUAL_COMPARE_MAX} 個標籤`;
    statusEl.classList.add('error');
    return;
  }

  statusEl.textContent = '比對名稱中…';
  statusEl.classList.remove('error');
  el('manual-overlap-matrix').style.display = 'none';

  try {
    const items = [];
    for (const name of names) {
      items.push(await resolveInterestByName_(name));
    }

    statusEl.textContent = '計算重疊中（每組要打好幾次 Meta API，會需要幾秒到十幾秒）…';
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        pairs.push([items[i].id, items[j].id]);
      }
    }
    const { results } = await apiPost({ action: 'estimateOverlap', pairs });
    renderOverlapMatrix(el('manual-overlap-matrix'), items, results);
    statusEl.textContent = '完成（比對到的名稱：' + items.map((i) => i.name).join('、') + '）';
  } catch (e) {
    statusEl.textContent = '錯誤：' + e.message;
    statusEl.classList.add('error');
  }
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join('_');
}

function ratioToColor(ratio) {
  if (ratio == null) return 'transparent';
  // 0% 白 → 100% 紅，重疊越高越顯眼，提醒不要疊用
  const intensity = Math.round(ratio * 200);
  return `rgb(255, ${255 - intensity}, ${255 - intensity})`;
}

init();
