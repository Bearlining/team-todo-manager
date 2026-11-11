/* ===== 财务待办 · 前端逻辑 ===== */

// ---------- 全局状态 ----------
let state = {
  userId: '',
  userName: '',
  categories: [],
  todos: [],
  reminders: [],
  calItems: [],
  mycalItems: [],
  // 列表筛选
  filterCat: '',           // '' = 全部
  filterStatus: 'pending', // 'pending' | 'done' | 'all'
  // 部门月历
  calView: 'month',        // 'month' | 'week'
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(), // 0-11
  calWeekStart: null,      // Date, 周一
  gantt: false,
  // 个人月历
  mycalView: 'month',
  mycalYear: new Date().getFullYear(),
  mycalMonth: new Date().getMonth(),
  mycalWeekStart: null,
  mycalGantt: false,
};

const AV_COLORS = ['#2d6cdf','#e8590c','#1e8e5a','#7048e8','#c62f2f','#0ca678','#e64980','#4263eb','#b9770a','#0b7285'];

// ---------- 工具函数 ----------
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function avColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

function avHtml(name, cls) {
  const ch = (name || '？').trim().charAt(0) || '？';
  return '<span class="' + cls + '" style="background:' + avColor(name) + '">' + esc(ch) + '</span>';
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function dstr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return dstr(new Date()); }
function parseD(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function fmtShort(s) { if (!s) return ''; const p = s.split('-'); return Number(p[1]) + '/' + Number(p[2]); }
function fmtMD(s) { if (!s) return ''; const p = s.split('-'); return Number(p[1]) + '月' + Number(p[2]) + '日'; }

// ---------- API 封装 ----------
async function api(path, opts) {
  opts = opts || {};
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('未登录'); }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res;
}

// ---------- 主题（localStorage 持久化，存 <html> 的 data-theme）----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t === 'blue' ? '' : t);
  // blue 是默认，空值即可
  if (t === 'blue') document.documentElement.removeAttribute('data-theme');
}
function loadTheme() {
  const t = localStorage.getItem('todo_theme') || 'blue';
  applyTheme(t);
  return t;
}
function markThemeUI(t) {
  const grid = $('#themeGrid');
  if (grid) $$('#themeGrid .theme-opt').forEach(o => o.classList.toggle('on', o.dataset.theme === t));
}

// ---------- Toast ----------
function toast(msg, type) {
  const wrap = $('#toastWrap');
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.innerHTML = esc(msg);
  wrap.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2200);
}

// ---------- 数据加载 ----------
async function loadUser() {
  const s = await api('/api/session');
  if (!s.logged_in) { location.href = '/login'; return; }
  state.userId = s.user_id;
  state.userName = s.user_name;
  $('#userChip').innerHTML = avHtml(s.user_name, 'user-av') +
    '<span>' + esc(s.user_name) +
    '<em style="font-style:normal;color:var(--doc-fg-sub);font-size:11.5px"> (' + esc(s.user_id) + ')</em></span>';
}

async function loadCategories() {
  const d = await api('/api/categories');
  state.categories = d.categories;
  renderFilterPills();
  renderCatSelect();
}

async function loadTodos() {
  const d = await api('/api/todos');
  state.todos = d.todos;
  renderTodoTable();
}

async function loadStats() {
  const s = await api('/api/stats');
  $('#stPending').textContent = s.pending;
  $('#stDone').textContent = s.done;
  $('#stDue').textContent = s.due_soon;
  $('#stSync').textContent = s.synced;
}

async function loadReminders() {
  const d = await api('/api/reminders');
  state.reminders = d.reminders;
  renderRemindBar();
}

async function loadCalendar() {
  const d = await api('/api/calendar');
  state.calItems = d.items;
  renderCalendar();
}

async function loadMyCalendar() {
  const d = await api('/api/my_calendar');
  state.mycalItems = d.items;
  renderMyCalendar();
}

async function refreshAll() {
  await Promise.all([loadCategories(), loadTodos(), loadStats(), loadReminders()]);
  if ($('#view-calendar').classList.contains('on')) await loadCalendar();
  if ($('#view-mycal').classList.contains('on')) await loadMyCalendar();
}

// ---------- 渲染：到期提醒条 ----------
function renderRemindBar() {
  const bar = $('#remindBar');
  if (!state.reminders.length) { bar.classList.remove('on'); return; }
  const overdue = state.reminders.filter(i => i.is_overdue).length;
  const today = state.reminders.length - overdue;
  let html = '';
  state.reminders.slice(0, 6).forEach(i => {
    const tag = i.is_overdue ? '<span class="tag-red">逾期</span>' : '<span class="tag-amber">今日到期</span>';
    html += tag + esc(i.name) + ' <span style="color:var(--doc-fg-sub)">' + fmtShort(i.due_date) + '</span><br>';
  });
  if (state.reminders.length > 6) html += '<span style="color:var(--doc-fg-sub)">…还有 ' + (state.reminders.length - 6) + ' 项</span>';
  $('#remindTitle').textContent = '你有 ' + state.reminders.length + ' 项待办需处理（逾期 ' + overdue + ' 项 / 今天到期 ' + today + ' 项）';
  $('#remindItems').innerHTML = html;
  bar.classList.add('on');
}

// ---------- 渲染：分类筛选 pills ----------
function renderFilterPills() {
  const row = $('#filterRow');
  if (!row) return;
  row.innerHTML = '<button class="filter-pill' + (state.filterCat === '' ? ' on' : '') + '" data-cat="" type="button">全部</button>' +
    state.categories.map(c =>
      '<button class="filter-pill' + (state.filterCat === String(c.id) ? ' on' : '') + '" data-cat="' + c.id + '" type="button">' +
      '<span class="dot" style="background:' + esc(c.color) + '"></span>' + esc(c.name) + '</button>'
    ).join('');
}

// ---------- 渲染：表单分类下拉 ----------
function renderCatSelect(selVal) {
  const sel = $('#catSelect');
  if (!sel) return;
  const val = selVal !== undefined ? selVal : '';
  sel.innerHTML = '<option value="">未分类</option>' +
    state.categories.map(c =>
      '<option value="' + c.id + '"' + (String(c.id) === String(val) ? ' selected' : '') + '>' + esc(c.name) + '</option>'
    ).join('');
}

// ---------- 渲染：待办表格 ----------
function renderTodoTable() {
  const body = $('#todoBody');
  const empty = $('#emptyState');
  const tableWrap = body.closest('.table-wrap');
  if (!body) return;
  const today = todayStr();
  let list = state.todos.slice();
  if (state.filterCat !== '') list = list.filter(x => String(x.category_id) === String(state.filterCat));
  if (state.filterStatus === 'pending') list = list.filter(x => !x.is_done);
  else if (state.filterStatus === 'done') list = list.filter(x => x.is_done);

  if (!list.length) {
    body.innerHTML = '';
    tableWrap.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  tableWrap.style.display = '';
  empty.style.display = 'none';
  body.innerHTML = list.map(x => {
    const overdue = !x.is_done && x.due_date < today;
    const isToday = !x.is_done && x.due_date === today;
    const dateCls = overdue ? 'overdue' : '';
    const suffix = overdue ? ' ⚠' : (isToday ? ' ·今天' : '');
    const cat = state.categories.find(c => String(c.id) === String(x.category_id));
    const catHtml = cat
      ? '<span class="cat-tag"><span class="dot" style="background:' + esc(cat.color) + '"></span>' + esc(cat.name) + '</span>'
      : '<span class="cat-tag" style="opacity:.6">未分类</span>';
    const sync = x.sync_calendar ? '<span class="sync-badge">已同步</span>' : '<span class="sync-badge off">未同步</span>';
    const recur = x.is_recurring
      ? '<span class="recur-tag">🔁 ' + (x.recur_type === 'month' ? '每月' : '每周') + '</span>'
      : '';
    return '<tr class="' + (x.is_done ? 'done' : '') + '">' +
      '<td><div class="check' + (x.is_done ? ' on' : '') + '" data-act="toggle" data-id="' + x.id + '"></div></td>' +
      '<td class="name"><span class="td-name">' + esc(x.name) + '</span>' + recur + '</td>' +
      '<td>' + catHtml + '</td>' +
      '<td><span class="date-range">' + fmtShort(x.start_date) + '<span class="sep">→</span>' +
        '<span class="' + dateCls + '">' + fmtShort(x.due_date) + suffix + '</span></span></td>' +
      '<td>' + sync + '</td>' +
      '<td><div class="row-actions">' +
        '<button class="icon-btn" data-act="edit" data-id="' + x.id + '" title="编辑">✎</button>' +
        '<button class="icon-btn del" data-act="del" data-id="' + x.id + '" title="删除">🗑</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

// ---------- 月历辅助 ----------
function getMonday(d) {
  const day = d.getDay() || 7; // 周日=7
  const diff = d.getDate() - day + 1;
  return new Date(d.getFullYear(), d.getMonth(), diff);
}

function monthStart(y, m) {
  // 返回该月日历的起始日（周一，含上月补齐）
  const first = new Date(y, m, 1);
  return getMonday(first);
}

// ---------- 渲染：月历标题 ----------
function updateCalTitle() {
  const t = $('#calTitle');
  if (state.calView === 'month') {
    t.innerHTML = state.calYear + '年 <span class="cur">' + (state.calMonth + 1) + '月</span>';
  } else {
    const ws = state.calWeekStart;
    const we = new Date(ws); we.setDate(we.getDate() + 6);
    t.innerHTML = fmtMD(dstr(ws)) + ' – ' + fmtMD(dstr(we));
  }
}

// ---------- 渲染：月历主体 ----------
function renderCalendar() {
  const body = $('#calBody');
  const grid = $('#calGrid');
  if (!body) return;
  updateCalTitle();
  grid.classList.toggle('gantt', state.gantt);

  let start, days;
  if (state.calView === 'month') {
    start = monthStart(state.calYear, state.calMonth);
    days = 42; // 固定6行
  } else {
    start = state.calWeekStart;
    days = 7;
  }

  const today = todayStr();
  const cells = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const ds = dstr(d);
    const isOther = state.calView === 'month' && d.getMonth() !== state.calMonth;
    const isToday = ds === today;

    // 该日期相关的待办（覆盖 start_date ~ due_date 区间）
    const items = state.calItems.filter(it => ds >= it.start_date && ds <= it.due_date);

    // 甘特图模式：每个被覆盖的日期画一段横条，首尾格做圆角连成整条
    let ganttBars = [];
    if (state.gantt) {
      items.forEach(it => {
        const isFirst = ds === it.start_date;
        const isLast = ds === it.due_date;
        ganttBars.push({ it, isFirst, isLast });
      });
    }

    cells.push({ ds, isOther, isToday, items, ganttBars, dayNum: d.getDate() });
  }

  // 构建 HTML
  let html = '';
  cells.forEach(cell => {
    html += '<div class="cal-cell' + (cell.isOther ? ' other' : '') + (cell.isToday ? ' today' : '') + '">';
    html += '<span class="daynum">' + cell.dayNum + '</span>';
    html += '<div class="cal-chips">';

    if (state.gantt && cell.ganttBars.length) {
      // 甘特图模式：每格画满格横条，首格左圆角、尾格右圆角，连成整条
      cell.ganttBars.forEach((g, gi) => {
        const it = g.it;
        const color = it.category_color || '#2d6cdf';
        let radius = '0';
        if (g.isFirst && g.isLast) radius = '5px';
        else if (g.isFirst) radius = '5px 0 0 5px';
        else if (g.isLast) radius = '0 5px 5px 0';
        const label = g.isFirst ? esc(it.creator_name) : '';
        html += '<div class="gantt-bar' + (it.is_done ? ' done' : '') + '" data-idx="' + it.id + '" ' +
          'style="background:' + color + ';border-radius:' + radius + ';top:' + (24 + gi * 17) + 'px" ' +
          'title="' + esc(it.name) + ' · ' + esc(it.creator_name) + ' (' + fmtShort(it.start_date) + ' – ' + fmtShort(it.due_date) + ')">' +
          '<span class="dot"></span><span class="lbl">' + label + '</span>' +
          '</div>';
      });
    } else {
      // 普通模式：显示 chip
      const MAX = state.calView === 'week' ? 8 : 4;
      cell.items.slice(0, MAX).forEach(it => {
        const dotCls = it.is_done ? 'green' : 'red';
        const avBg = avColor(it.creator_name);
        const whoChar = (it.creator_name || '？').charAt(0);
        html += '<div class="cal-chip' + (it.is_done ? ' done' : '') + '" data-idx="' + it.id + '">' +
          '<span class="dot ' + dotCls + '"></span>' +
          '<span class="av" style="background:' + avBg + '">' + esc(whoChar) + '</span>' +
          '<span class="txt">' +
          (it.category_name ? '<span class="cat">' + esc(it.category_name) + '</span>' : '') +
          '<span class="itemname">' + esc(it.name) + '</span>' +
          '</span></div>';
      });
      if (cell.items.length > MAX) {
        html += '<span class="cal-more">+' + (cell.items.length - MAX) + ' 更多</span>';
      }
    }
    html += '</div></div>';
  });
  body.innerHTML = html;
  renderCalLegend();
}

// ---------- 部门月历：头像→姓名 图例 ----------
function renderCalLegend() {
  const el = $('#calLegend');
  if (!el) return;
  const people = {};
  state.calItems.forEach(it => {
    if (it.creator_name && !people[it.creator_employee_id]) {
      people[it.creator_employee_id] = it.creator_name;
    }
  });
  const keys = Object.keys(people);
  if (!keys.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = '<span class="lg-label">成员：</span>' + keys.map(k =>
    '<span class="lg-item">' + avHtml(people[k], 'lg-av') + esc(people[k]) + '</span>'
  ).join('');
}

// ---------- 渲染：个人月历（无姓名，分类 + 事项）----------
function updateMyCalTitle() {
  const t = $('#mycalTitle');
  if (!t) return;
  if (state.mycalView === 'month') {
    t.innerHTML = state.mycalYear + '年 <span class="cur">' + (state.mycalMonth + 1) + '月</span>';
  } else {
    const ws = state.mycalWeekStart;
    const we = new Date(ws); we.setDate(we.getDate() + 6);
    t.innerHTML = fmtMD(dstr(ws)) + ' – ' + fmtMD(dstr(we));
  }
}

function renderMyCalendar() {
  const body = $('#mycalBody');
  const grid = $('#mycalGrid');
  if (!body) return;
  updateMyCalTitle();
  grid.classList.toggle('gantt', state.mycalGantt);

  let start, days;
  if (state.mycalView === 'month') {
    start = monthStart(state.mycalYear, state.mycalMonth);
    days = 42;
  } else {
    start = state.mycalWeekStart;
    days = 7;
  }

  const today = todayStr();
  const cells = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const ds = dstr(d);
    const isOther = state.mycalView === 'month' && d.getMonth() !== state.mycalMonth;
    const isToday = ds === today;
    const items = state.mycalItems.filter(it => ds >= it.start_date && ds <= it.due_date);
    let ganttBars = [];
    if (state.mycalGantt) {
      items.forEach(it => ganttBars.push({ it, isFirst: ds === it.start_date, isLast: ds === it.due_date }));
    }
    cells.push({ ds, isOther, isToday, items, ganttBars, dayNum: d.getDate() });
  }

  let html = '';
  cells.forEach(cell => {
    html += '<div class="cal-cell' + (cell.isOther ? ' other' : '') + (cell.isToday ? ' today' : '') + '">';
    html += '<span class="daynum">' + cell.dayNum + '</span>';
    html += '<div class="cal-chips">';
    if (state.mycalGantt && cell.ganttBars.length) {
      cell.ganttBars.forEach((g, gi) => {
        const it = g.it;
        const color = it.category_color || '#2d6cdf';
        let radius = '0';
        if (g.isFirst && g.isLast) radius = '5px';
        else if (g.isFirst) radius = '5px 0 0 5px';
        else if (g.isLast) radius = '0 5px 5px 0';
        const label = g.isFirst ? (it.category_name || '') + ' ' + esc(it.name) : '';
        html += '<div class="gantt-bar' + (it.is_done ? ' done' : '') + '" data-idx="' + it.id + '" ' +
          'style="background:' + color + ';border-radius:' + radius + ';top:' + (24 + gi * 17) + 'px" ' +
          'title="' + esc(it.name) + ' (' + fmtShort(it.start_date) + ' – ' + fmtShort(it.due_date) + ')">' +
          '<span class="dot"></span><span class="lbl">' + label + '</span></div>';
      });
    } else {
      const MAX = state.mycalView === 'week' ? 8 : 5;
      cell.items.slice(0, MAX).forEach(it => {
        const dotCls = it.is_done ? 'green' : 'red';
        html += '<div class="cal-chip' + (it.is_done ? ' done' : '') + '" data-idx="' + it.id + '">' +
          '<span class="dot ' + dotCls + '"></span>' +
          '<span class="txt"><span class="itemname">' + esc(it.name) + '</span>' +
          (it.category_name ? ' <span class="cat">' + esc(it.category_name) + '</span>' : '') +
          '</span></div>';
      });
      if (cell.items.length > MAX) {
        html += '<span class="cal-more">+' + (cell.items.length - MAX) + ' 更多</span>';
      }
    }
    html += '</div></div>';
  });
  body.innerHTML = html;
}

// ---------- 个人月历导航 ----------
function mycalNav(dir) {
  if (state.mycalView === 'month') {
    let m = state.mycalMonth + dir, y = state.mycalYear;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    state.mycalMonth = m; state.mycalYear = y;
  } else {
    state.mycalWeekStart.setDate(state.mycalWeekStart.getDate() + dir * 7);
  }
  renderMyCalendar();
}
function mycalGoToday() {
  const now = new Date();
  state.mycalYear = now.getFullYear();
  state.mycalMonth = now.getMonth();
  state.mycalWeekStart = getMonday(now);
  renderMyCalendar();
}

// ---------- 待办弹窗 ----------
function openTodoModal(todo) {
  const f = $('#todoForm');
  f.reset();
  $('#todoModalTitle').textContent = todo ? '编辑待办' : '新建待办';
  renderCatSelect();
  if (todo) {
    f.id.value = todo.id;
    f.name.value = todo.name;
    f.start_date.value = todo.start_date;
    f.due_date.value = todo.due_date;
    f.recur_type.value = todo.recur_type || '';
    f.sync_calendar.checked = !!todo.sync_calendar;
    renderCatSelect(todo.category_id || '');
  } else {
    f.id.value = '';
    f.start_date.value = todayStr();
    f.due_date.value = todayStr();
    f.recur_type.value = '';
  }
  $('#todoModal').style.display = 'flex';
  setTimeout(() => f.name.focus(), 50);
}

function closeTodoModal() { $('#todoModal').style.display = 'none'; }

async function submitTodo(e) {
  e.preventDefault();
  const f = $('#todoForm');
  const id = f.id.value;
  const payload = {
    name: f.name.value.trim(),
    category_id: f.category_id.value ? Number(f.category_id.value) : null,
    start_date: f.start_date.value,
    due_date: f.due_date.value,
    recur_type: f.recur_type.value,
    sync_calendar: f.sync_calendar.checked,
  };
  if (!payload.name) { toast('请填写待办名称', 'err'); return; }
  if (!payload.due_date) { toast('请选择截止日期', 'err'); return; }
  if (payload.start_date > payload.due_date) { toast('开始日期不能晚于截止日期', 'err'); return; }

  const res = id ? await api('/api/todos/' + id, { method: 'PUT', body: payload })
                 : await api('/api/todos', { method: 'POST', body: payload });
  if (res.success === false) { toast(res.message || '保存失败', 'err'); return; }
  toast(id ? '已更新' : '已创建', 'ok');
  closeTodoModal();
  await refreshAll();
}

// ---------- 分类管理弹窗 ----------
function openCatModal() { renderCatList(); $('#catModal').style.display = 'flex'; }
function closeCatModal() { $('#catModal').style.display = 'none'; }

// 分类项 HTML（预设与自定义都支持改名/改色/删除）
function catItemHtml(c) {
  const preset = c.is_preset ? '<span class="preset-tag">预设</span>' : '';
  return '<div class="cat-item" data-cid="' + c.id + '">' +
    '<input type="color" class="cat-edit-color" value="' + esc(c.color) + '" data-colorpick="' + c.id + '" title="点击修改颜色">' +
    '<span class="nm" data-catname="' + c.id + '" title="点击修改名称">' + esc(c.name) + '</span>' +
    preset +
    '<button class="icon-btn del" data-catdel="' + c.id + '" title="删除">🗑</button>' +
    '</div>';
}

function renderCatList() {
  const list = $('#catList');
  if (list) list.innerHTML = state.categories.map(catItemHtml).join('');
}

async function addCategory() {
  const name = $('#newCatName').value.trim();
  if (!name) { toast('请输入分类名', 'err'); return; }
  const res = await api('/api/categories', { method: 'POST', body: { name, color: $('#newCatColor').value } });
  if (res.success === false) { toast(res.message || '添加失败', 'err'); return; }
  $('#newCatName').value = '';
  toast('已添加', 'ok');
  await loadCategories();
  renderCatList();
}

async function deleteCategory(id) {
  if (!confirm('删除该分类后，其下待办将变为"未分类"，确定删除？')) return;
  const res = await api('/api/categories/' + id, { method: 'DELETE' });
  if (res.success === false) { toast(res.message || '删除失败', 'err'); return; }
  toast('已删除', 'ok');
  await loadCategories();
  await loadTodos();
  renderCatList();
  if ($('#view-settings').classList.contains('on')) renderSettingsCats();
}

// 修改分类名称（预设与自定义都可改）
async function renameCategory(id) {
  const c = state.categories.find(x => String(x.id) === String(id));
  if (!c) return;
  const name = prompt('修改分类名称', c.name);
  if (name === null) return;
  const nv = name.trim();
  if (!nv) { toast('名称不能为空', 'err'); return; }
  const res = await api('/api/categories/' + id, { method: 'PUT', body: { name: nv, color: c.color } });
  if (res.success === false) { toast(res.message || '修改失败', 'err'); return; }
  toast('已修改', 'ok');
  await loadCategories();
  renderCatList();
  if ($('#view-settings').classList.contains('on')) renderSettingsCats();
}

// 修改分类颜色
async function recolorCategory(id, color) {
  const c = state.categories.find(x => String(x.id) === String(id));
  if (!c) return;
  const res = await api('/api/categories/' + id, { method: 'PUT', body: { name: c.name, color } });
  if (res.success !== false) { renderCatList(); if ($('#view-settings').classList.contains('on')) renderSettingsCats(); }
}

// 统一的分类列表事件（改名/改色/删除），catList 与 catListSettings 共用
function bindCatListEvents(root) {
  root.addEventListener('click', e => {
    const del = e.target.closest('[data-catdel]');
    if (del) { deleteCategory(del.dataset.catdel); return; }
    const nm = e.target.closest('[data-catname]');
    if (nm) renameCategory(nm.dataset.catname);
  });
  root.addEventListener('change', e => {
    const cp = e.target.closest('[data-colorpick]');
    if (cp) recolorCategory(cp.dataset.colorpick, cp.value);
  });
}

// ---------- 月历待办详情弹窗 ----------
function openDetailModal(itemId) {
  const it = state.calItems.find(x => String(x.id) === String(itemId));
  if (!it) return;
  const body = $('#detailBody');
  const avBg = avColor(it.creator_name);
  const statusHtml = it.is_done
    ? '<span class="dstatus done">✓ 已完成</span>'
    : '<span class="dstatus pending">未完成</span>';
  const recurHtml = it.is_recurring
    ? ' <span class="recur-tag" style="margin-left:0">🔁 ' + (it.recur_type === 'month' ? '每月' : '每周') + '</span>'
    : '';
  body.innerHTML =
    '<div class="detail-head">' +
      '<div class="dav" style="background:' + avBg + '">' + esc((it.creator_name || '？').charAt(0)) + '</div>' +
      '<div class="dt"><div class="dn">' + esc(it.name) + '</div>' +
      '<div class="dwho">' + esc(it.creator_name) + ' <span style="color:var(--doc-fg-sub)">· ' + esc(it.creator_employee_id) + '</span></div></div>' +
    '</div>' +
    '<div class="detail-body">' +
      '<div class="drow"><span class="k">分类</span><span class="v">' +
        (it.category_name ? '<span class="cat-tag"><span class="dot" style="background:' + esc(it.category_color || '#8a94a3') + '"></span>' + esc(it.category_name) + '</span>' : '未分类') +
        recurHtml + '</span></div>' +
      '<div class="drow"><span class="k">开始日期</span><span class="v">' + fmtMD(it.start_date) + '</span></div>' +
      '<div class="drow"><span class="k">截止日期</span><span class="v">' + fmtMD(it.due_date) + '</span></div>' +
      '<div class="drow"><span class="k">状态</span>' + statusHtml + '</div>' +
    '</div>' +
    (it.creator_id === state.userId ? '' : '<p class="dread-only">这是其他同事同步的待办，仅供查看</p>');
  $('#detailModal').style.display = 'flex';
}
function closeDetailModal() { $('#detailModal').style.display = 'none'; }

// ---------- 个人月历待办详情弹窗 ----------
function openMyDetailModal(itemId) {
  const it = state.mycalItems.find(x => String(x.id) === String(itemId));
  if (!it) return;
  const body = $('#detailBody');
  const statusHtml = it.is_done
    ? '<span class="dstatus done">✓ 已完成</span>'
    : '<span class="dstatus pending">未完成</span>';
  const recurHtml = it.is_recurring
    ? ' <span class="recur-tag" style="margin-left:0">🔁 ' + (it.recur_type === 'month' ? '每月' : '每周') + '</span>'
    : '';
  body.innerHTML =
    '<div class="detail-body">' +
      '<div class="drow"><span class="k">待办</span><span class="v">' + esc(it.name) + '</span></div>' +
      '<div class="drow"><span class="k">分类</span><span class="v">' +
        (it.category_name ? '<span class="cat-tag"><span class="dot" style="background:' + esc(it.category_color || '#8a94a3') + '"></span>' + esc(it.category_name) + '</span>' : '未分类') +
        recurHtml + '</span></div>' +
      '<div class="drow"><span class="k">开始日期</span><span class="v">' + fmtMD(it.start_date) + '</span></div>' +
      '<div class="drow"><span class="k">截止日期</span><span class="v">' + fmtMD(it.due_date) + '</span></div>' +
      '<div class="drow"><span class="k">状态</span>' + statusHtml + '</div>' +
    '</div>';
  $('#detailModal').style.display = 'flex';
}

// ---------- 设置页 ----------
function renderSettingsCats() {
  const list = $('#catListSettings');
  if (!list) return;
  list.innerHTML = state.categories.map(catItemHtml).join('');
}

async function changePassword(e) {
  e.preventDefault();
  const f = $('#pwdForm');
  const old_pwd = f.old_pwd.value, new_pwd = f.new_pwd.value, new_pwd2 = f.new_pwd2.value;
  if (new_pwd.length < 6) { toast('新密码至少 6 位', 'err'); return; }
  if (new_pwd !== new_pwd2) { toast('两次输入的新密码不一致', 'err'); return; }
  const res = await api('/api/password', { method: 'PUT', body: { old_pwd, new_pwd } });
  if (res.success === false) { toast(res.message || '修改失败', 'err'); return; }
  toast('密码已更新', 'ok');
  f.reset();
}

// ---------- 注销账号（不可逆，双重确认）----------
async function deleteAccount() {
  const pw = ($('#delPw') || {}).value || '';
  if (!pw) { toast('请输入登录密码以确认注销', 'err'); return; }
  if (!confirm('确定要注销账号吗？')) return;
  if (!confirm('再次确认：所有数据（含已同步到部门月历的历史记录）将被永久删除，无法恢复。')) return;
  const res = await api('/api/account/delete', { method: 'DELETE', body: { password: pw } });
  if (res.success === false) { toast(res.message || '注销失败', 'err'); return; }
  location.href = '/login';
}

function bindSettings() {
  // 修改密码
  const pwdForm = $('#pwdForm');
  if (pwdForm) pwdForm.addEventListener('submit', changePassword);
  // 主题切换
  $$('#themeGrid .theme-opt').forEach(o => o.addEventListener('click', () => {
    const t = o.dataset.theme;
    localStorage.setItem('todo_theme', t);
    applyTheme(t);
    markThemeUI(t);
  }));
  // 设置页分类管理
  const addBtn2 = $('#btnAddCat2');
  if (addBtn2) addBtn2.addEventListener('click', () => {
    const name = $('#newCatName2').value.trim();
    if (!name) { toast('请输入分类名', 'err'); return; }
    api('/api/categories', { method: 'POST', body: { name, color: $('#newCatColor2').value } }).then(r => {
      if (r.success !== false) { toast('已添加', 'ok'); $('#newCatName2').value = ''; loadCategories().then(renderSettingsCats); }
    });
  });
  const list = $('#catListSettings');
  if (list) bindCatListEvents(list);
  // 注销账号
  const delBtn = $('#btnDelAccount');
  if (delBtn) delBtn.addEventListener('click', deleteAccount);
}

// ---------- 视图切换 ----------
function switchView(name) {
  $$('.view').forEach(v => v.classList.remove('on'));
  $('#view-' + name).classList.add('on');
  $$('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  if (name === 'calendar') loadCalendar();
  if (name === 'mycal') loadMyCalendar();
  if (name === 'settings') renderSettingsCats();
}

// ---------- 月历导航 ----------
function calNav(dir) {
  if (state.calView === 'month') {
    let m = state.calMonth + dir, y = state.calYear;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    state.calMonth = m; state.calYear = y;
  } else {
    state.calWeekStart.setDate(state.calWeekStart.getDate() + dir * 7);
  }
  renderCalendar();
}

function calGoToday() {
  const now = new Date();
  state.calYear = now.getFullYear();
  state.calMonth = now.getMonth();
  state.calWeekStart = getMonday(now);
  renderCalendar();
}

// ---------- 导出 ----------
function exportCsv() {
  const params = new URLSearchParams();
  if (state.filterCat !== '') {
    const c = state.categories.find(x => String(x.id) === String(state.filterCat));
    if (c) params.set('category', c.name);
  }
  if (state.filterStatus === 'pending' || state.filterStatus === 'done') params.set('status', state.filterStatus);
  const qs = params.toString();
  window.location.href = '/api/export' + (qs ? '?' + qs : '');
}

// ---------- 退出 ----------
async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login';
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // 视图切换
  $$('.tab-btn').forEach(b => b.addEventListener('click', e => { e.preventDefault(); switchView(b.dataset.view); }));

  // 分类筛选
  $('#filterRow').addEventListener('click', e => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    state.filterCat = btn.dataset.cat;
    renderFilterPills();
    renderTodoTable();
  });

  // 状态筛选
  $('#statusSeg').addEventListener('click', e => {
    const btn = e.target.closest('[data-status]');
    if (!btn) return;
    state.filterStatus = btn.dataset.status;
    $$('#statusSeg [data-status]').forEach(b => b.classList.toggle('on', b === btn));
    renderTodoTable();
  });

  // 新建 / 导出 / 管理分类
  $('#addTodoBtn').addEventListener('click', () => openTodoModal(null));
  $('#exportBtn').addEventListener('click', exportCsv);
  $('#btnManageCats').addEventListener('click', openCatModal);

  // 待办表格：完成/编辑/删除
  $('#todoBody').addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const id = t.dataset.id, act = t.dataset.act;
    if (act === 'toggle') {
      api('/api/todos/' + id + '/toggle', { method: 'PUT' }).then(r => {
        if (r.success !== false) {
          if (r.next_due) toast('已完成，已自动生成下一轮（' + fmtShort(r.next_due) + ' 截止）', 'ok');
          refreshAll();
        }
      });
    } else if (act === 'edit') {
      const todo = state.todos.find(x => String(x.id) === String(id));
      if (todo) openTodoModal(todo);
    } else if (act === 'del') {
      const todo = state.todos.find(x => String(x.id) === String(id));
      if (todo && confirm('确定删除「' + todo.name + '」？')) {
        api('/api/todos/' + id, { method: 'DELETE' }).then(r => { if (r.success !== false) { toast('已删除', 'ok'); refreshAll(); } });
      }
    }
  });

  // 待办弹窗
  $('#todoModalClose').addEventListener('click', closeTodoModal);
  $('#todoCancelBtn').addEventListener('click', closeTodoModal);
  $('#todoForm').addEventListener('submit', submitTodo);
  $('#todoModal').addEventListener('click', e => { if (e.target.id === 'todoModal') closeTodoModal(); });

  // 分类弹窗
  $('#catModalClose').addEventListener('click', closeCatModal);
  $('#catCancelBtn').addEventListener('click', closeCatModal);
  $('#btnAddCat').addEventListener('click', addCategory);
  $('#newCatName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } });
  bindCatListEvents($('#catList'));
  $('#catModal').addEventListener('click', e => { if (e.target.id === 'catModal') closeCatModal(); });

  // 提醒条关闭
  $('#remindClose').addEventListener('click', () => $('#remindBar').classList.remove('on'));

  // 月历导航
  $('#calPrev').addEventListener('click', () => calNav(-1));
  $('#calNext').addEventListener('click', () => calNav(1));
  $('#calToday').addEventListener('click', calGoToday);
  $('#calSeg').addEventListener('click', e => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    state.calView = btn.dataset.mode;
    $$('#calSeg [data-mode]').forEach(b => b.classList.toggle('on', b === btn));
    if (state.calView === 'week' && !state.calWeekStart) state.calWeekStart = getMonday(new Date());
    renderCalendar();
  });
  $('#ganttToggle').addEventListener('change', e => { state.gantt = e.target.checked; renderCalendar(); });

  // 个人月历导航
  $('#mycalPrev').addEventListener('click', () => mycalNav(-1));
  $('#mycalNext').addEventListener('click', () => mycalNav(1));
  $('#mycalToday').addEventListener('click', mycalGoToday);
  $('#mycalSeg').addEventListener('click', e => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    state.mycalView = btn.dataset.mode;
    $$('#mycalSeg [data-mode]').forEach(b => b.classList.toggle('on', b === btn));
    if (state.mycalView === 'week' && !state.mycalWeekStart) state.mycalWeekStart = getMonday(new Date());
    renderMyCalendar();
  });
  $('#mycalGantt').addEventListener('change', e => { state.mycalGantt = e.target.checked; renderMyCalendar(); });
  // 个人月历 chip / 甘特条 点击 → 详情（复用部门月历详情弹窗，但个人项无 creator 字段，单独处理）
  $('#mycalBody').addEventListener('click', e => {
    const chip = e.target.closest('[data-idx]');
    if (chip) openMyDetailModal(chip.dataset.idx);
  });

  // 月历 chip / 甘特条 点击 → 详情
  $('#calBody').addEventListener('click', e => {
    const chip = e.target.closest('[data-idx]');
    if (chip) openDetailModal(chip.dataset.idx);
  });
  $('#detailClose').addEventListener('click', closeDetailModal);
  $('#detailOkBtn').addEventListener('click', closeDetailModal);
  $('#detailModal').addEventListener('click', e => { if (e.target.id === 'detailModal') closeDetailModal(); });

  // 退出
  $('#logoutBtn').addEventListener('click', logout);

  // 设置页
  bindSettings();

  // ESC 关闭弹窗
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeTodoModal(); closeCatModal(); closeDetailModal(); }
  });
}

// ---------- 初始化 ----------
async function init() {
  const theme = loadTheme();
  markThemeUI(theme);
  await loadUser();
  state.calWeekStart = getMonday(new Date());
  state.mycalWeekStart = getMonday(new Date());
  bindEvents();
  await refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
