// 極簡 vanilla JS，沒有框架、沒有 build step，直接開 index.html 或丟 GitHub Pages 就能跑。

// Web App 網址是固定的，寫死在這裡就好，不需要使用者自己貼；
// apiKey 則從分享連結的 ?key= 參數自動帶入（見 init() 底部），不做成畫面上的輸入框。
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxsLaM_z7wYqkJPfAVa0A6fWhbH7fyoQHMHTmmOK3Ra-ts7xJZnpyjTtVOCvV9737J4/exec';

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
  worklist: [], // [{id, name, path}]
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

  el('search-btn').addEventListener('click', runSearch);
  el('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  el('compute-overlap-btn').addEventListener('click', computeOverlap);
  el('copy-for-ai-btn').addEventListener('click', copyForAI);
  el('manual-compare-btn').addEventListener('click', computeManualOverlap);
  initTabs();

  loadCategories();
  renderWorklist();
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
        runSearch();
      });
      list.appendChild(li);
    });
  } catch (e) {
    console.error(e);
  }
}

async function runSearch() {
  const q = el('search-input').value.trim();
  const statusEl = el('search-status');
  if (!q) return;
  statusEl.textContent = '搜尋中…';
  statusEl.classList.remove('error');
  try {
    const results = await apiGet('searchInterests', { q });
    const list = el('search-results');
    list.innerHTML = '';
    results.slice(0, 100).forEach((item) => {
      const li = document.createElement('li');
      const pathText = safeParsePath(item.path).join(' > ');
      li.textContent = `${item.name}（${pathText}）`;
      li.addEventListener('click', () => addToWorklist(item));
      list.appendChild(li);
    });
    statusEl.textContent = `找到 ${results.length} 筆`;
  } catch (e) {
    statusEl.textContent = '錯誤：' + e.message;
    statusEl.classList.add('error');
  }
}

function safeParsePath(path) {
  if (Array.isArray(path)) return path;
  try { return JSON.parse(path || '[]'); } catch (e) { return []; }
}

function addToWorklist(item) {
  if (state.worklist.some((w) => String(w.id) === String(item.id))) return;
  state.worklist.push({ id: item.id, name: item.name, path: safeParsePath(item.path) });
  renderWorklist();
}

function removeFromWorklist(id) {
  state.worklist = state.worklist.filter((w) => String(w.id) !== String(id));
  renderWorklist();
}

function renderWorklist() {
  const container = el('worklist');
  container.innerHTML = '';
  if (!state.worklist.length) {
    container.innerHTML = '<div class="status">從左邊搜尋結果點選，加進這裡</div>';
  }
  state.worklist.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'workitem';
    div.innerHTML = `
      <div class="name">${item.name}</div>
      <div class="path">${item.path.join(' > ')}</div>
      <div class="actions">
        <button data-action="related">找相關</button>
        <button data-action="remove">移除</button>
      </div>
    `;
    div.querySelector('[data-action="related"]').addEventListener('click', () => findRelated(item));
    div.querySelector('[data-action="remove"]').addEventListener('click', () => removeFromWorklist(item.id));
    container.appendChild(div);
  });
  el('compute-overlap-btn').disabled = state.worklist.length < 2;
}

async function findRelated(item) {
  try {
    // 一併帶上名稱：Meta 的 suggestion API 吃名稱，後端才不用回頭去 Sheet 反查
    const suggestions = await apiGet('suggestRelated', { seed_ids: item.id, seed_names: item.name });
    const list = el('suggestion-list');
    list.innerHTML = '';
    suggestions.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item.name + (item.audience_size ? `（${item.audience_size}）` : '');
      li.addEventListener('click', () => addToWorklist(item));
      list.appendChild(li);
    });
  } catch (e) {
    alert('找相關失敗：' + e.message);
  }
}

async function computeOverlap() {
  const statusEl = el('worklist-status');
  statusEl.textContent = '計算重疊中（每組要打好幾次 Meta API，會需要幾秒到十幾秒）…';
  statusEl.classList.remove('error');
  try {
    const pairs = [];
    for (let i = 0; i < state.worklist.length; i++) {
      for (let j = i + 1; j < state.worklist.length; j++) {
        pairs.push([state.worklist[i].id, state.worklist[j].id]);
      }
    }
    const { results } = await apiPost({ action: 'estimateOverlap', pairs });
    renderOverlapMatrix(el('overlap-matrix'), state.worklist, results);
    statusEl.textContent = '完成';
  } catch (e) {
    statusEl.textContent = '錯誤：' + e.message;
    statusEl.classList.add('error');
  }
}

// items: [{id, name}]，跟 state.worklist 無關——工作清單跟自行比對兩種情境共用同一個畫表格函式
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

// 跟上面「搜尋 → 加進工作清單 → 算重疊」完全獨立：使用者直接打字給名稱，
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

function copyForAI() {
  if (!state.worklist.length) return;
  const lines = ['以下是我從 Meta 興趣受眾探索工具挑出的候選興趣，請在這個範圍內幫我做受眾發想：', ''];
  state.worklist.forEach((item) => {
    lines.push(`- ${item.name}（分類：${item.path.join(' > ') || '未知'}）`);
  });
  const text = lines.join('\n');
  navigator.clipboard.writeText(text).then(() => {
    el('worklist-status').textContent = '已複製到剪貼簿，可以貼到 Claude / ChatGPT 對話裡了';
    el('worklist-status').classList.remove('error');
  });
}

init();
