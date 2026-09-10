/**
 * ============================================================
 * js/options.js
 * 规则设置页逻辑（Ext / Type / Regex / blockUrl 四张表）
 * ------------------------------------------------------------
 * 数据存 chrome.storage.sync.userRules；保存后 background.js 通过
 * storage.onChanged 热更新，立即生效，无需重载扩展。
 *
 * 🔴 核心安全承诺：四张表全部留空 = 与历史默认行为完全一致。
 *    未配置的用户升级后行为零变化（不会误伤、误删任何资源）。
 *
 * 规则结构：
 *   Ext[]:     { ext, operator, size, unit, state }
 *   Type[]:    { type, operator, size, unit, state }
 *   Regex[]:   { regex, type(标志), blackList, replaceTo, state }
 *   blockUrl:  { list: string[], white: boolean }
 * ============================================================
 */

const OPS = ['>=', '<=', '>', '<', '=', '!=', '~'];
const UNITS = ['B', 'KB', 'MB', 'GB'];
const TABLE_OF_BODY = { extBody: 'Ext', typeBody: 'Type', regexBody: 'Regex' };

let rules = emptyRules();
let statusTimer = null;

function emptyRules() {
  return { Ext: [], Type: [], Regex: [], blockUrl: { list: [], white: false } };
}

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function optionsHtml(list, selected) {
  return list.map((v) =>
    `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`
  ).join('');
}

// 把任意输入规整为合法结构（防脏数据导致渲染/保存出错）
function normalize(incoming) {
  const r = emptyRules();
  if (!incoming || typeof incoming !== 'object') return r;
  const op = (v) => (OPS.indexOf(v) >= 0 ? v : '>=');
  const unit = (v) => (UNITS.indexOf(v) >= 0 ? v : 'KB');
  const state = (v) => !(v === false);
  if (Array.isArray(incoming.Ext)) {
    r.Ext = incoming.Ext.map((x) => ({
      ext: String((x && x.ext) || ''), operator: op(x && x.operator),
      size: String(x && x.size != null ? x.size : ''), unit: unit(x && x.unit), state: state(x && x.state)
    }));
  }
  if (Array.isArray(incoming.Type)) {
    r.Type = incoming.Type.map((x) => ({
      type: String((x && x.type) || ''), operator: op(x && x.operator),
      size: String(x && x.size != null ? x.size : ''), unit: unit(x && x.unit), state: state(x && x.state)
    }));
  }
  if (Array.isArray(incoming.Regex)) {
    r.Regex = incoming.Regex.map((x) => ({
      regex: String((x && x.regex) || ''), type: String((x && x.type) || ''),
      blackList: !!(x && x.blackList), replaceTo: String((x && x.replaceTo) || ''), state: state(x && x.state)
    }));
  }
  const bl = incoming.blockUrl;
  if (bl && typeof bl === 'object' && Array.isArray(bl.list)) {
    r.blockUrl = { list: bl.list.map(String), white: !!bl.white };
  }
  return r;
}

// ---------- 渲染 ----------
function renderExt() {
  const tb = $('extBody');
  if (!rules.Ext.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">暂无规则。留空表示沿用默认逻辑（扩展名白名单 + 内置尺寸阈值）。</td></tr>';
    return;
  }
  tb.innerHTML = rules.Ext.map((r, i) => `
    <tr data-idx="${i}">
      <td class="col-state"><input type="checkbox" data-field="state" ${r.state ? 'checked' : ''}></td>
      <td><input type="text" data-field="ext" value="${escapeHtml(r.ext)}" placeholder="mp4"></td>
      <td><select data-field="operator">${optionsHtml(OPS, r.operator)}</select></td>
      <td><input type="text" data-field="size" value="${escapeHtml(r.size)}" placeholder="500 或 500-1000"></td>
      <td><select data-field="unit">${optionsHtml(UNITS, r.unit)}</select></td>
      <td class="col-del"><button class="row-del danger" data-del="Ext" data-idx="${i}">删除</button></td>
    </tr>`).join('');
}

function renderType() {
  const tb = $('typeBody');
  if (!rules.Type.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">暂无规则。留空表示沿用默认逻辑（content-type 校验 + 内置尺寸阈值）。</td></tr>';
    return;
  }
  tb.innerHTML = rules.Type.map((r, i) => `
    <tr data-idx="${i}">
      <td class="col-state"><input type="checkbox" data-field="state" ${r.state ? 'checked' : ''}></td>
      <td><input type="text" data-field="type" value="${escapeHtml(r.type)}" placeholder="video/*"></td>
      <td><select data-field="operator">${optionsHtml(OPS, r.operator)}</select></td>
      <td><input type="text" data-field="size" value="${escapeHtml(r.size)}" placeholder="500 或 500-1000"></td>
      <td><select data-field="unit">${optionsHtml(UNITS, r.unit)}</select></td>
      <td class="col-del"><button class="row-del danger" data-del="Type" data-idx="${i}">删除</button></td>
    </tr>`).join('');
}

function renderRegex() {
  const tb = $('regexBody');
  if (!rules.Regex.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="6">暂无规则。留空表示不启用任何自定义正则（不影响原有过滤逻辑）。</td></tr>';
    return;
  }
  tb.innerHTML = rules.Regex.map((r, i) => `
    <tr data-idx="${i}">
      <td class="col-state"><input type="checkbox" data-field="state" ${r.state ? 'checked' : ''}></td>
      <td><input type="text" data-field="regex" value="${escapeHtml(r.regex)}" placeholder="\\.mp4(\\?|$)"></td>
      <td><input type="text" data-field="type" value="${escapeHtml(r.type)}" placeholder="i"></td>
      <td class="col-black"><input type="checkbox" data-field="blackList" ${r.blackList ? 'checked' : ''}></td>
      <td><input type="text" data-field="replaceTo" value="${escapeHtml(r.replaceTo)}" placeholder="$1"></td>
      <td class="col-del"><button class="row-del danger" data-del="Regex" data-idx="${i}">删除</button></td>
    </tr>`).join('');
}

function renderBlock() {
  document.querySelectorAll('input[name="blockMode"]').forEach((el) => {
    el.checked = (el.value === 'white') === rules.blockUrl.white;
  });
  $('blockList').value = rules.blockUrl.list.join('\n');
}

function renderTable(table) {
  if (table === 'Ext') renderExt();
  else if (table === 'Type') renderType();
  else if (table === 'Regex') renderRegex();
}

function renderAll() {
  renderExt();
  renderType();
  renderRegex();
  renderBlock();
}

// ---------- 行内编辑（事件委托） ----------
function onRowInput(e) {
  const el = e.target;
  const field = el.dataset && el.dataset.field;
  if (!field) return;
  const tr = el.closest('tr');
  const tb = el.closest('tbody');
  if (!tr || !tb) return;
  const table = TABLE_OF_BODY[tb.id];
  const idx = parseInt(tr.dataset.idx, 10);
  if (!table || isNaN(idx) || !rules[table][idx]) return;
  rules[table][idx][field] = (el.type === 'checkbox') ? el.checked : el.value;
}

function onRowClick(e) {
  const btn = e.target.closest('button[data-del]');
  if (!btn) return;
  const table = btn.dataset.del;
  const idx = parseInt(btn.dataset.idx, 10);
  if (!table || isNaN(idx) || !rules[table]) return;
  rules[table].splice(idx, 1);
  renderTable(table);
}

Object.keys(TABLE_OF_BODY).forEach((bodyId) => {
  const tb = $(bodyId);
  if (!tb) return;
  tb.addEventListener('input', onRowInput);
  tb.addEventListener('change', onRowInput);
  tb.addEventListener('click', onRowClick);
});

// ---------- 添加行 ----------
document.querySelectorAll('button[data-add]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.add;
    if (t === 'Ext') rules.Ext.push({ ext: '', operator: '>=', size: '', unit: 'KB', state: true });
    else if (t === 'Type') rules.Type.push({ type: '', operator: '>=', size: '', unit: 'KB', state: true });
    else if (t === 'Regex') rules.Regex.push({ regex: '', type: '', blackList: false, replaceTo: '', state: true });
    renderTable(t);
  });
});

// ---------- URL 黑白名单 ----------
document.querySelectorAll('input[name="blockMode"]').forEach((el) => {
  el.addEventListener('change', () => {
    if (!el.checked) return;
    rules.blockUrl.white = (el.value === 'white');
  });
});
$('blockList').addEventListener('input', () => {
  rules.blockUrl.list = $('blockList').value.split('\n').map((s) => s.trim()).filter(Boolean);
});

// ---------- 正则测试 ----------
$('testBtn').addEventListener('click', () => {
  const url = $('testUrl').value.trim();
  const res = $('testResult');
  if (!url) { res.textContent = '请输入测试 URL'; res.style.color = '#b45309'; return; }
  const enabled = rules.Regex.filter((r) => r.state !== false && String(r.regex || '').trim());
  if (!enabled.length) { res.textContent = '没有启用且已填写正则的规则'; res.style.color = '#6b7280'; return; }
  const r = enabled[0];
  try {
    const re = new RegExp(r.regex, r.type || '');
    const m = re.exec(url);
    if (!m) { res.textContent = '未命中（第一条启用规则）'; res.style.color = '#6b7280'; return; }
    let msg = '命中：' + m[0];
    if (r.blackList) msg += ' → 该资源会被丢弃';
    if (r.replaceTo) {
      try { msg += ' → 改写为：' + url.replace(re, r.replaceTo); } catch (e) { /* ignore */ }
    }
    res.textContent = msg;
    res.style.color = '#059669';
  } catch (e) {
    res.textContent = '正则非法：' + String(e && e.message || e);
    res.style.color = '#b91c1c';
  }
});

// ---------- 保存 / 重置 ----------
// 保存前清理：丢掉全空行、去掉扩展名前导点，避免脏数据
function cleanup() {
  rules.Ext = rules.Ext
    .map((r) => ({ ...r, ext: String(r.ext || '').replace(/^\./, '').trim() }))
    .filter((r) => r.ext !== '');
  rules.Type = rules.Type.filter((r) => String(r.type || '').trim() !== '');
  rules.Regex = rules.Regex.filter((r) => String(r.regex || '').trim() !== '');
}

function status(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = isError ? '#b91c1c' : '#059669';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 3000);
}

$('save').addEventListener('click', () => {
  cleanup();
  renderAll();
  try {
    chrome.storage.sync.set({ userRules: rules }, () => {
      if (chrome.runtime.lastError) {
        status('保存失败：' + chrome.runtime.lastError.message, true);
        return;
      }
      status('已保存，规则已立即生效', false);
    });
  } catch (e) {
    status('保存失败：' + String(e && e.message || e), true);
  }
});

$('reset').addEventListener('click', () => {
  rules = emptyRules();
  renderAll();
  try {
    chrome.storage.sync.set({ userRules: rules }, () => {
      if (chrome.runtime.lastError) { status('清空失败：' + chrome.runtime.lastError.message, true); return; }
      status('已清空全部规则，恢复默认行为', false);
    });
  } catch (e) {
    status('清空失败：' + String(e && e.message || e), true);
  }
});

// ---------- 下载设置（storage.local，不随账号同步） ----------
function loadDownloadPref() {
  try {
    chrome.storage.local.get('downloadSaveAs', (r) => {
      const el = $('saveAsPref');
      if (el) el.checked = !!(r && r.downloadSaveAs === true);
    });
  } catch (e) { /* ignore */ }
}
const saveAsEl = $('saveAsPref');
if (saveAsEl) {
  saveAsEl.addEventListener('change', () => {
    try {
      chrome.storage.local.set({ downloadSaveAs: saveAsEl.checked }, () => {
        if (chrome.runtime.lastError) { status('保存失败：' + chrome.runtime.lastError.message, true); return; }
        status('已保存下载设置', false);
      });
    } catch (e) {
      status('保存失败：' + String(e && e.message || e), true);
    }
  });
}

// ---------- 初始加载 ----------
function load() {
  loadDownloadPref();
  try {
    chrome.storage.sync.get('userRules', (result) => {
      if (!chrome.runtime.lastError && result && result.userRules) {
        rules = normalize(result.userRules);
      }
      renderAll();
    });
  } catch (e) {
    renderAll();
  }
}
load();
