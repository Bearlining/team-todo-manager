"""
团队待办管理系统
Flask + SQLite + 原生前端
"""
import logging
from flask import Flask, request, jsonify, render_template, session, redirect, url_for, Response
from flask_cors import CORS
import sqlite3
import hashlib
import logging
import os
import csv
import io
from datetime import datetime, timedelta, date

# 关闭 werkzeug 默认访问日志（每个请求一行，很刷屏），只保留错误级
logging.getLogger('werkzeug').setLevel(logging.ERROR)

# 关闭请求级访问日志，避免控制台刷屏（仅保留错误级别）
logging.getLogger('werkzeug').setLevel(logging.ERROR)

app = Flask(__name__)

# Session 签名密钥：优先读环境变量，没配就用随机值（每次重启变化，
# 后果是已登录用户需重新登录）。不要把固定密钥硬编码进代码。
app.secret_key = os.environ.get('TODO_SECRET_KEY') or os.urandom(32).hex()
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
CORS(app, resources={r"/api/*": {"origins": "*"}})

DB_NAME = 'todo.db'
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, DB_NAME)

# 预设分类及颜色（用户可在设置页自行改名/改色/增删）
PRESET_CATEGORIES = [
    {'name': '日常', 'color': '#5a6675'},
    {'name': '重要', 'color': '#c62f2f'},
    {'name': '协作', 'color': '#2d6cdf'},
    {'name': '跟进', 'color': '#e8590c'},
    {'name': '长期', 'color': '#7048e8'},
    {'name': '其他', 'color': '#1e8e5a'},
]

# 自定义分类可用色板
COLOR_PALETTE = ['#e8590c', '#1e8e5a', '#7048e8', '#c62f2f', '#2d6cdf', '#b9770a', '#0ca678', '#e64980', '#4263eb', '#f59f00']


def get_db():
    # timeout=30：连接遇到锁时最多等待 30 秒再报错，避免多请求并发瞬间撞锁
    # 页面一打开会同时发 /api/todos、/api/stats、/api/reminders 等多个请求，
    # SQLite 是单写者模型，排队等锁比直接抛 "database is locked" 更稳。
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA busy_timeout=30000')   # 兜底：忙等 30 秒
    conn.execute('PRAGMA journal_mode=WAL')     # WAL 提升并发读写
    conn.execute('PRAGMA synchronous=NORMAL')   # WAL 下足够安全且更快
    return conn


def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            is_preset INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category_id INTEGER,
            category_name TEXT,
            category_color TEXT,
            start_date TEXT NOT NULL,
            due_date TEXT NOT NULL,
            is_done INTEGER DEFAULT 0,
            sync_calendar INTEGER DEFAULT 0,
            is_recurring INTEGER DEFAULT 0,
            recur_type TEXT DEFAULT '',
            creator_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    ''')
    # 兼容旧库：补充循环待办字段（已存在则忽略）
    for col, ddl in [('is_recurring', 'INTEGER DEFAULT 0'), ('recur_type', "TEXT DEFAULT ''")]:
        try:
            conn.execute(f'ALTER TABLE todos ADD COLUMN {col} {ddl}')
        except Exception:
            pass
    # 兼容旧库：补充分类快照字段（分类删除后待办仍保留当时的分类名/色）
    for col, ddl in [('category_name', 'TEXT'), ('category_color', 'TEXT')]:
        try:
            conn.execute(f'ALTER TABLE todos ADD COLUMN {col} {ddl}')
        except Exception:
            pass
    # 兼容旧库：users 表补充分类初始化标记（允许删除预设分类后不再自动补回）
    try:
        conn.execute('ALTER TABLE users ADD COLUMN cat_initialized INTEGER DEFAULT 1')
    except Exception:
        pass
    # 回填：给已有待办补分类快照（取当前分类；分类已删则保持 NULL）
    try:
        conn.execute('''
            UPDATE todos SET
              category_name = (SELECT name FROM categories c WHERE c.id = todos.category_id),
              category_color = (SELECT color FROM categories c WHERE c.id = todos.category_id)
            WHERE category_id IS NOT NULL
        ''')
    except Exception:
        pass
    conn.commit()
    conn.close()


def cat_snapshot(conn, category_id, user_id):
    """根据 category_id 取 (name, color) 快照；无则返回 (None, None)"""
    if category_id in (None, ''):
        return (None, None)
    row = conn.execute(
        'SELECT name, color FROM categories WHERE id = ? AND user_id = ?',
        (category_id, user_id)
    ).fetchone()
    if not row:
        return (None, None)
    return (row['name'], row['color'])


def parse_date(s):
    """'YYYY-MM-DD' -> date 对象"""
    y, m, d = str(s).split('-')[:3]
    return date(int(y), int(m), int(d))


def add_period(d, period):
    """按周期向后滚动一个周期：week=+7天，month=+1月（处理月末溢出）"""
    if period == 'week':
        return d + timedelta(days=7)
    # month
    y, m = d.year, d.month + 1
    if m > 12:
        m = 1; y += 1
    # 处理月末溢出（如 1/31 -> 2/28）
    import calendar as _cal
    max_day = _cal.monthrange(y, m)[1]
    return date(y, m, min(d.day, max_day))


def hash_password(password):
    """PBKDF2-HMAC-SHA256，每用户独立随机盐。

    旧版本用的是 MD5(固定盐 + 密码)，这里保留 verify 以便老库平滑迁移：
    老哈希验证通过后，下一次登录会自动重算成 PBKDF2。
    """
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100_000)
    return 'pbkdf2$100000$' + salt.hex() + '$' + dk.hex()


def verify_password(password, stored):
    """校验密码，兼容三种历史格式。"""
    if not stored:
        return False
    if stored.startswith('pbkdf2$'):
        try:
            _, iters, salt_hex, hash_hex = stored.split('$')
            dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'),
                                    bytes.fromhex(salt_hex), int(iters))
            return dk.hex() == hash_hex
        except Exception:
            return False
    # 旧格式：MD5(固定盐 + 密码)
    return hashlib.md5(('fin_todo_salt_2026' + password).encode('utf-8')).hexdigest() == stored


def get_user_by_id(employee_id):
    conn = get_db()
    row = conn.execute('SELECT * FROM users WHERE employee_id = ?', (employee_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_or_init_categories(employee_id):
    """首次使用时初始化预设分类（用标记位判断，删光预设后也不会自动补回）"""
    conn = get_db()
    user = conn.execute('SELECT cat_initialized FROM users WHERE employee_id = ?', (employee_id,)).fetchone()
    if user and not user['cat_initialized']:
        for i, cat in enumerate(PRESET_CATEGORIES):
            conn.execute(
                'INSERT INTO categories (user_id, name, color, is_preset, sort_order) VALUES (?,?,?,?,?)',
                (employee_id, cat['name'], cat['color'], 1, i)
            )
        conn.execute('UPDATE users SET cat_initialized = 1 WHERE employee_id = ?', (employee_id,))
        conn.commit()
    conn.close()


@app.before_request
def _clear_stale_session():
    """'幽灵登录'自动登出：session 里的账号在库中已不存在
    （如账号已注销、或浏览器带着旧实例的登录 cookie 访问了一个
    全新/不同的数据库）时，清空 session。受保护接口随后返回 401，
    前端自动跳回登录页，避免'直接登录成功但数据状态错乱'。"""
    uid = session.get('user_id')
    if uid and get_user_by_id(uid) is None:
        session.clear()


# ============ 页面路由 ============

@app.route('/login')
def login_page():
    if 'user_id' in session:
        return redirect('/')
    return render_template('login.html')


@app.route('/')
def index_page():
    if 'user_id' not in session:
        return redirect('/login')
    return render_template('index.html', user_id=session['user_id'], user_name=session['user_name'])


# ============ 认证 API ============

@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()
    employee_id = (data.get('employee_id') or '').strip()
    name = (data.get('name') or '').strip()
    password = (data.get('password') or '').strip()

    if not employee_id or not name or not password:
        return jsonify({'success': False, 'message': '工号、姓名、密码均不能为空'})
    if len(password) < 4:
        return jsonify({'success': False, 'message': '密码至少 4 位'})

    existing = get_user_by_id(employee_id)
    if existing:
        return jsonify({'success': False, 'message': '该工号已注册，请直接登录'})

    conn = get_db()
    try:
        # cat_initialized=0：确保首次打开时 get_or_init_categories 会写入预设分类
        conn.execute(
            'INSERT INTO users (employee_id, name, password_hash, cat_initialized) VALUES (?,?,?,0)',
            (employee_id, name, hash_password(password))
        )
        conn.commit()
    except Exception as e:
        conn.close()
        return jsonify({'success': False, 'message': f'注册失败: {str(e)}'})
    conn.close()

    get_or_init_categories(employee_id)

    session.permanent = True
    session['user_id'] = employee_id
    session['user_name'] = name
    return jsonify({'success': True, 'message': '注册成功'})


@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    employee_id = (data.get('employee_id') or '').strip()
    password = (data.get('password') or '').strip()

    if not employee_id or not password:
        return jsonify({'success': False, 'message': '工号和密码不能为空'})

    user = get_user_by_id(employee_id)
    if not user or not verify_password(password, user['password_hash']):
        return jsonify({'success': False, 'message': '工号或密码错误'})

    # 老库（MD5）平滑迁移：验证通过后重算成 PBKDF2，下次就用新格式了
    if not user['password_hash'].startswith('pbkdf2$'):
        try:
            conn = get_db()
            conn.execute('UPDATE users SET password_hash=? WHERE employee_id=?',
                         (hash_password(password), employee_id))
            conn.commit()
            conn.close()
        except Exception:
            pass

    session.permanent = True
    session['user_id'] = employee_id
    session['user_name'] = user['name']
    return jsonify({'success': True, 'message': '登录成功'})


@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})


@app.route('/api/account/delete', methods=['DELETE'])
def delete_account():
    """注销账号：校验密码后删除该工号全部数据（待办/分类/用户），并退出登录"""
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    data = request.get_json(silent=True) or {}
    pw = (data.get('password') or '').strip()
    employee_id = session['user_id']
    user = get_user_by_id(employee_id)
    if not user or not verify_password(pw, user['password_hash']):
        return jsonify({'success': False, 'message': '密码不正确，无法注销'})
    conn = get_db()
    try:
        # 删除顺序：待办 -> 分类 -> 用户（含同步到部门月历的历史待办）
        conn.execute('DELETE FROM todos WHERE creator_id = ?', (employee_id,))
        conn.execute('DELETE FROM categories WHERE user_id = ?', (employee_id,))
        conn.execute('DELETE FROM users WHERE employee_id = ?', (employee_id,))
        conn.commit()
    except Exception as e:
        conn.close()
        return jsonify({'success': False, 'message': f'注销失败: {str(e)}'})
    conn.close()
    session.clear()
    return jsonify({'success': True, 'message': '账号已注销'})


@app.route('/api/password', methods=['PUT'])
def change_password():
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    data = request.get_json()
    # 兼容前端字段命名：old_pwd/new_pwd 或 old_password/new_password
    old_pw = (data.get('old_pwd') or data.get('old_password') or '').strip()
    new_pw = (data.get('new_pwd') or data.get('new_password') or '').strip()
    if len(new_pw) < 4:
        return jsonify({'success': False, 'message': '新密码至少 4 位'})
    user = get_user_by_id(session['user_id'])
    if not user or not verify_password(old_pw, user['password_hash']):
        return jsonify({'success': False, 'message': '原密码不正确'})
    conn = get_db()
    conn.execute('UPDATE users SET password_hash=? WHERE employee_id=?',
                 (hash_password(new_pw), session['user_id']))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'message': '密码已修改'})


@app.route('/api/session', methods=['GET'])
def check_session():
    if 'user_id' in session:
        return jsonify({'logged_in': True, 'user_id': session['user_id'], 'user_name': session['user_name']})
    return jsonify({'logged_in': False})


# ============ 分类 API ============

@app.route('/api/categories', methods=['GET'])
def get_categories():
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    employee_id = session['user_id']
    get_or_init_categories(employee_id)
    conn = get_db()
    rows = conn.execute('SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order', (employee_id,)).fetchall()
    conn.close()
    return jsonify({'categories': [dict(r) for r in rows]})


@app.route('/api/categories', methods=['POST'])
def add_category():
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    data = request.get_json()
    name = (data.get('name') or '').strip()
    color = (data.get('color') or '').strip()
    if not name:
        return jsonify({'success': False, 'message': '分类名不能为空'})
    if not color:
        color = COLOR_PALETTE[len(os.listdir(DB_PATH)) % len(COLOR_PALETTE)] if os.path.exists(DB_PATH) else '#5a6675'
        # 简单取一个
        color = COLOR_PALETTE[hash(name) % len(COLOR_PALETTE)]

    conn = get_db()
    count = conn.execute('SELECT COUNT(*) FROM categories WHERE user_id = ?', (session['user_id'],)).fetchone()[0]
    conn.execute(
        'INSERT INTO categories (user_id, name, color, is_preset, sort_order) VALUES (?,?,?,?,?)',
        (session['user_id'], name, color, 0, count + 1)
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/categories/<int:cat_id>', methods=['PUT'])
def update_category(cat_id):
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    data = request.get_json()
    conn = get_db()
    row = conn.execute('SELECT * FROM categories WHERE id = ? AND user_id = ?', (cat_id, session['user_id'])).fetchone()
    if not row:
        conn.close()
        return jsonify({'success': False, 'message': '分类不存在'}), 404
    name = (data.get('name') or row['name']).strip() or row['name']
    color = data.get('color') or row['color']
    conn.execute('UPDATE categories SET name=?, color=? WHERE id=?', (name, color, cat_id))
    # 同步该用户所有关联待办的分类快照（改名/改色实时生效，部门月历也可见）
    conn.execute(
        'UPDATE todos SET category_name=?, category_color=? WHERE category_id=? AND creator_id=?',
        (name, color, cat_id, session['user_id'])
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/categories/<int:cat_id>', methods=['DELETE'])
def delete_category(cat_id):
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    conn = get_db()
    row = conn.execute('SELECT * FROM categories WHERE id = ? AND user_id = ?', (cat_id, session['user_id'])).fetchone()
    if not row:
        conn.close()
        return jsonify({'success': False, 'message': '分类不存在'}), 404
    # 删除关联待办的分类（预设与自定义均可删，待办变为"未分类"）
    conn.execute('UPDATE todos SET category_id = NULL WHERE category_id = ? AND creator_id = ?', (cat_id, session['user_id']))
    conn.execute('DELETE FROM categories WHERE id = ?', (cat_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# ============ 待办 API ============

@app.route('/api/todos', methods=['GET'])
def get_todos():
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    employee_id = session['user_id']
    conn = get_db()
    rows = conn.execute('''
        SELECT t.id, t.name, t.category_id,
               COALESCE(t.category_name, c.name) as category_name,
               COALESCE(t.category_color, c.color) as category_color,
               t.start_date, t.due_date, t.is_done, t.sync_calendar,
               t.is_recurring, t.recur_type, t.created_at
        FROM todos t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.creator_id = ?
        ORDER BY t.is_done ASC, t.due_date ASC, t.created_at DESC
    ''', (employee_id,)).fetchall()
    conn.close()
    todos = []
    for r in rows:
        d = dict(r)
        d['is_done'] = bool(d['is_done'])
        d['sync_calendar'] = bool(d['sync_calendar'])
        d['is_recurring'] = bool(d['is_recurring'])
        todos.append(d)
    return jsonify({'todos': todos})


@app.route('/api/todos', methods=['POST'])
def create_todo():
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    data = request.get_json()
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'success': False, 'message': '待办名称不能为空'})
    category_id = data.get('category_id')
    start_date = (data.get('start_date') or date.today().isoformat()).strip()
    due_date = (data.get('due_date') or '').strip()
    if not due_date:
        return jsonify({'success': False, 'message': '截止日期不能为空'})
    is_done = 1 if data.get('is_done') else 0
    sync_calendar = 1 if data.get('sync_calendar') else 0
    recur_type = (data.get('recur_type') or '').strip()
    if recur_type not in ('week', 'month'):
        recur_type = ''
    is_recurring = 1 if recur_type else 0

    conn = get_db()
    cname, ccolor = cat_snapshot(conn, category_id, session['user_id'])
    cursor = conn.execute(
        'INSERT INTO todos (name, category_id, category_name, category_color, start_date, due_date, is_done, sync_calendar, is_recurring, recur_type, creator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        (name, category_id, cname, ccolor, start_date, due_date, is_done, sync_calendar, is_recurring, recur_type, session['user_id'])
    )
    todo_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'id': todo_id})


@app.route('/api/todos/<int:todo_id>', methods=['PUT'])
def update_todo(todo_id):
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    data = request.get_json()
    conn = get_db()
    row = conn.execute('SELECT * FROM todos WHERE id = ? AND creator_id = ?', (todo_id, session['user_id'])).fetchone()
    if not row:
        conn.close()
        return jsonify({'success': False, 'message': '待办不存在'}), 404

    name = data.get('name', row['name'])
    category_id = data.get('category_id', row['category_id'])
    start_date = data.get('start_date', row['start_date'])
    due_date = data.get('due_date', row['due_date'])
    old_done = row['is_done']
    is_done = 1 if data.get('is_done', row['is_done']) else 0
    sync_calendar = 1 if data.get('sync_calendar', row['sync_calendar']) else 0
    recur_type = (data.get('recur_type') or row['recur_type'] or '').strip()
    if recur_type not in ('week', 'month'):
        recur_type = ''
    is_recurring = 1 if recur_type else 0
    cname, ccolor = cat_snapshot(conn, category_id, session['user_id'])

    conn.execute('''
        UPDATE todos SET name=?, category_id=?, category_name=?, category_color=?,
        start_date=?, due_date=?, is_done=?, sync_calendar=?,
        is_recurring=?, recur_type=?, updated_at=datetime('now','localtime') WHERE id=?
    ''', (name, category_id, cname, ccolor, start_date, due_date, is_done, sync_calendar, is_recurring, recur_type, todo_id))

    # 编辑时若把循环待办从"未完成"改为"已完成"，也触发滚动
    if old_done == 0 and is_done == 1 and recur_type:
        roll_recurring(conn, todo_id, recur_type, due_date)
    conn.commit()
    conn.close()
    return jsonify({'success': True})


def roll_recurring(conn, todo_id, period, current_due):
    """循环待办完成后，基于当前截止日期向后滚一个周期，生成下一轮（未完成）"""
    cur = parse_date(current_due)
    new_due = add_period(cur, period)
    # 保持与本轮相同的时长
    try:
        cur_start = parse_date(conn.execute('SELECT start_date FROM todos WHERE id=?', (todo_id,)).fetchone()['start_date'])
        new_start = add_period(cur_start, period)
    except Exception:
        new_start = new_due
    conn.execute(
        'INSERT INTO todos (name, category_id, category_name, category_color, start_date, due_date, is_done, sync_calendar, is_recurring, recur_type, creator_id) '
        'SELECT name, category_id, category_name, category_color, ?, ?, 0, sync_calendar, is_recurring, recur_type, creator_id FROM todos WHERE id=?',
        (new_start.isoformat(), new_due.isoformat(), todo_id)
    )
    return new_due.isoformat()


@app.route('/api/todos/<int:todo_id>/toggle', methods=['PUT'])
def toggle_todo(todo_id):
    """快速切换完成状态"""
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    conn = get_db()
    row = conn.execute('SELECT * FROM todos WHERE id = ? AND creator_id = ?', (todo_id, session['user_id'])).fetchone()
    if not row:
        conn.close()
        return jsonify({'success': False, 'message': '待办不存在'}), 404
    new_state = 0 if row['is_done'] else 1
    conn.execute("UPDATE todos SET is_done=?, updated_at=datetime('now','localtime') WHERE id=?", (new_state, todo_id))
    next_due = None
    # 完成循环待办时，向后滚动生成下一轮
    if new_state == 1 and row['is_recurring'] and row['recur_type']:
        next_due = roll_recurring(conn, todo_id, row['recur_type'], row['due_date'])
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'is_done': bool(new_state), 'next_due': next_due})


@app.route('/api/todos/<int:todo_id>', methods=['DELETE'])
def delete_todo(todo_id):
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    conn = get_db()
    row = conn.execute('SELECT * FROM todos WHERE id = ? AND creator_id = ?', (todo_id, session['user_id'])).fetchone()
    if not row:
        conn.close()
        return jsonify({'success': False, 'message': '待办不存在'}), 404
    conn.execute('DELETE FROM todos WHERE id = ?', (todo_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# ============ 部门月历 API ============

@app.route('/api/calendar', methods=['GET'])
def get_calendar():
    """获取部门月历数据：所有同步到月历的待办"""
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    conn = get_db()
    rows = conn.execute('''
        SELECT t.id, t.name, t.category_id,
               COALESCE(t.category_name, c.name) as category_name,
               COALESCE(t.category_color, c.color) as category_color,
               t.start_date, t.due_date, t.is_done, t.is_recurring, t.recur_type,
               u.name as creator_name, u.employee_id as creator_employee_id,
               u.employee_id as creator_id
        FROM todos t
        JOIN users u ON t.creator_id = u.employee_id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.sync_calendar = 1
        ORDER BY t.start_date ASC, t.due_date ASC
    ''').fetchall()
    conn.close()
    items = []
    for r in rows:
        d = dict(r)
        d['is_done'] = bool(d['is_done'])
        items.append(d)
    return jsonify({'items': items})


# ============ 个人月历 API ============

@app.route('/api/my_calendar', methods=['GET'])
def get_my_calendar():
    """获取当前用户全部待办（个人月历用，不分 sync_calendar）"""
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    conn = get_db()
    rows = conn.execute('''
        SELECT t.id, t.name, t.category_id,
               COALESCE(t.category_name, c.name) as category_name,
               COALESCE(t.category_color, c.color) as category_color,
               t.start_date, t.due_date, t.is_done, t.is_recurring, t.recur_type
        FROM todos t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.creator_id = ?
        ORDER BY t.start_date ASC, t.due_date ASC
    ''', (session['user_id'],)).fetchall()
    conn.close()
    items = []
    for r in rows:
        d = dict(r)
        d['is_done'] = bool(d['is_done'])
        d['is_recurring'] = bool(d['is_recurring'])
        items.append(d)
    return jsonify({'items': items})


# ============ 到期提醒 API ============

@app.route('/api/reminders', methods=['GET'])
def get_reminders():
    """获取今天到期或已逾期的未完成待办"""
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    today = date.today().isoformat()
    conn = get_db()
    rows = conn.execute('''
        SELECT t.id, t.name, t.category_id,
               COALESCE(t.category_name, c.name) as category_name,
               COALESCE(t.category_color, c.color) as category_color,
               t.start_date, t.due_date, t.is_done
        FROM todos t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.creator_id = ? AND t.is_done = 0 AND t.due_date <= ?
        ORDER BY t.due_date ASC
    ''', (session['user_id'], today)).fetchall()
    conn.close()
    reminders = []
    for r in rows:
        d = dict(r)
        d['is_overdue'] = d['due_date'] < today
        reminders.append(d)
    return jsonify({'reminders': reminders, 'count': len(reminders)})


# ============ 统计 API ============

@app.route('/api/stats', methods=['GET'])
def get_stats():
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    today = date.today().isoformat()
    upcoming = (date.today() + timedelta(days=3)).isoformat()
    conn = get_db()
    pending = conn.execute('SELECT COUNT(*) FROM todos WHERE creator_id=? AND is_done=0', (session['user_id'],)).fetchone()[0]
    done = conn.execute('SELECT COUNT(*) FROM todos WHERE creator_id=? AND is_done=1', (session['user_id'],)).fetchone()[0]
    due_soon = conn.execute('SELECT COUNT(*) FROM todos WHERE creator_id=? AND is_done=0 AND due_date<=?', (session['user_id'], upcoming)).fetchone()[0]
    synced = conn.execute('SELECT COUNT(*) FROM todos WHERE creator_id=? AND sync_calendar=1', (session['user_id'],)).fetchone()[0]
    conn.close()
    return jsonify({'pending': pending, 'done': done, 'due_soon': due_soon, 'synced': synced})


# ============ 导出 CSV ============

@app.route('/api/export', methods=['GET'])
def export_csv():
    if 'user_id' not in session:
        return jsonify({'error': '未登录'}), 401
    # 支持筛选参数
    category_name = request.args.get('category', '').strip()
    status = request.args.get('status', '').strip()  # 'pending' / 'done' / ''

    conn = get_db()
    query = '''
        SELECT t.name, COALESCE(t.category_name, c.name) as category, t.start_date, t.due_date,
               CASE WHEN t.is_done=1 THEN '已完成' ELSE '未完成' END as status,
               CASE WHEN t.sync_calendar=1 THEN '是' ELSE '否' END as sync_cal,
               t.created_at
        FROM todos t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.creator_id = ?
    '''
    params = [session['user_id']]
    if category_name:
        query += ' AND COALESCE(t.category_name, c.name) = ?'
        params.append(category_name)
    if status == 'pending':
        query += ' AND t.is_done = 0'
    elif status == 'done':
        query += ' AND t.is_done = 1'
    query += ' ORDER BY t.is_done ASC, t.due_date ASC'

    rows = conn.execute(query, params).fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['待办名称', '分类', '开始日期', '截止日期', '状态', '同步月历', '创建时间'])
    for r in rows:
        writer.writerow([r['name'], r['category'] or '', r['start_date'], r['due_date'], r['status'], r['sync_cal'], r['created_at']])

    # BOM for Excel 中文兼容
    csv_content = output.getvalue()
    return Response(
        '\ufeff' + csv_content,
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename=team_todos_{date.today().isoformat()}.csv'}
    )


# ============ 启动 ============

if __name__ == '__main__':
    init_db()
    # 获取内网 IP
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = '127.0.0.1'

    print('=' * 50)
    print('   团队待办管理系统 启动成功!')
    print('=' * 50)
    print(f'   本机访问: http://127.0.0.1:5001/')
    print(f'   内网访问: http://{local_ip}:5001/')
    print('=' * 50)
    print('   关闭此窗口即停止服务')
    print('=' * 50)
    try:
        # threaded=True：多线程处理请求，刷新/多人并发不再排队卡住
        # use_reloader=False：关掉热重载，避免子进程残留占用端口
        app.run(host='0.0.0.0', port=5001, debug=False,
                use_reloader=False, threaded=True)
    except OSError as e:
        print('=' * 50)
        print('   端口 5001 被占用，服务无法启动！')
        print('   可能原因：')
        print('   1. 已有一个服务在运行 —— 直接用浏览器打开 http://127.0.0.1:5001/')
        print('   2. 上次未正常关闭，残留进程占着端口（可在任务管理器结束 python.exe）')
        print(f'   错误详情：{e}')
        print('=' * 50)
        input('按回车键退出...')
