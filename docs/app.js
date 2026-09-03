// 極簡 vanilla JS，沒有框架、沒有 build step，直接開 index.html 或丟 GitHub Pages 就能跑。

const state = {
  webappUrl: localStorage.getItem('webappUrl') || '',
  apiKey: localStorage.getItem('apiKey') || '',
  worklist: [], // [{id, name, path}]
};

const el = (id) => document.getElementById(id);

function init() {
  el('webapp-url').value = state.webappUrl;
  el('api-key').value = state.apiKey;

  el('save-config').addEventListener('click', () => {
    state.webappUrl = el('webapp-url').value.trim().replace(/\/$/, '');
    state.apiKey = el('api-key').value.trim();
    localStorage.setItem('webappUrl', state.webappUrl);
    localStorage.setItem('apiKey', state.apiKey);
    loadCategories();
  });

  el('search-btn').addEventListener('click', runSearch);
  el('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  el('compute-overlap-btn').addEventListener('click', computeOverlap);
  el('copy-for-ai-btn').addEventListener('click', copyForAI);

  if (state.webappUrl) loadCategories();
  renderWorklist();
}

function requireUrl() {
  if (!state.webappUrl) {
    alert('請先貼上並儲存 Apps Script Web App 的 URL');
    throw new Error('missing webapp url');
  }
}

async function apiGet(action, params) {
  requireUrl();
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${state.webappUrl}?${qs}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

async function apiPost(body) {
  requireUrl();
  const res = await fetch(state.webappUrl, {
    method: 'POST',
    // 用 text/plain 避免瀏覽器對 Apps Script Web App 發出 CORS preflight（Apps Script 對 OPTIONS 的支援不完整）
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, apiKey: state.apiKey }),
  });
  const json = await res.json();
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
    renderOverlapMatrix(results);
    statusEl.textContent = '完成';
  } catch (e) {
    statusEl.textContent = '錯誤：' + e.message;
    statusEl.classList.add('error');
  }
}

function renderOverlapMatrix(results) {
  const table = el('overlap-matrix');
  const idToName = Object.fromEntries(state.worklist.map((w) => [String(w.id), w.name]));
  const ratioByPair = {};
  results.forEach((r) => {
    ratioByPair[pairKey(r.interest_a, r.interest_b)] = r.overlap_ratio;
  });

  const ids = state.worklist.map((w) => w.id);
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
