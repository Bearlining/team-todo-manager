# 团队待办管理系统

一个面向团队的轻量待办协作工具。多人各自维护待办，可选择同步到「团队月历」共享查看。

**Flask + SQLite + 原生前端**，无框架、无构建步骤、依赖只有两个包。

---

## 快速开始

### 方式一：便携版（推荐给非技术同事）

下载 [Releases 里的便携版 zip](https://github.com/Bearlining/team-todo-manager/releases)，解压后双击 `启动待办.bat` 即可。

- **已内置 Python 运行时**，目标电脑无需预装 Python
- 首次运行需联网装依赖，之后完全离线可用
- 详细说明见便携版包内的 `README.md`

### 方式二：源码运行

要求 Python 3.8+。

```bash
git clone https://github.com/Bearlining/team-todo-manager.git
cd team-todo-manager
pip install -r requirements.txt
python app.py
```

浏览器打开 <http://127.0.0.1:5001/>，首次进入点「注册」用「工号 + 姓名 + 密码」建号。

启动时终端会打印两个地址：

```
本机访问: http://127.0.0.1:5001/
内网访问: http://192.168.x.x:5001/     ← 发这个给同事
```

同事在同一局域网内就能访问（需放行 5001 端口）。

---

## 功能

| 功能 | 说明 |
|---|---|
| **我的待办** | 增删改查、分类、开始/截止日期、完成状态、到期提醒条 |
| **个人月历** | 只看自己的全部待办，月/周视图 + 可选甘特图 |
| **部门月历** | 只读展示所有人同步过来的待办，红点=未完成、绿点=已完成，含「头像→姓名」图例 |
| **循环待办** | 周/月循环，完成后自动滚动生成下一轮，从截止日起滚、月末自动收敛，不会无限创建 |
| **分类管理** | 每人独立的分类表，可增/改/删；**删分类不丢待办的分类信息**（快照机制） |
| **CSV 导出** | 按分类/状态筛选导出，带 BOM，Excel 打开中文不乱码 |
| **主题切换** | 蓝色 / 绿色 / 暖色 / 深色 4 套，localStorage 记忆 |
| **账号** | 工号 + 姓名 + 密码注册登录，30 天免登录，改密码，注销账号（连带清除全部数据） |

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Python 3 + Flask | 全部 API 与业务逻辑集中在 `app.py` |
| 数据库 | SQLite | `todo.db`，与 `app.py` 同目录，自动创建，WAL 模式 |
| 前端 | 原生 HTML / CSS / JS | 无框架、无构建，改完刷新即生效 |
| 会话 | Flask session | cookie-based，30 天有效 |

依赖只有两个：`flask`、`flask-cors`。

---

## 目录结构

```
team-todo-manager/
├── app.py                 # Flask 后端：全部 API、建表、业务逻辑
├── requirements.txt       # flask, flask-cors
├── 启动待办.bat            # Windows 一键启动（GBK 编码）
├── todo.db                # SQLite 数据库（运行后自动生成，已 gitignore）
├── templates/
│   ├── login.html         # 登录 / 注册页（内联 JS，不加载 app.js）
│   └── index.html         # 主页面：4 个视图 + 弹窗
└── static/
    ├── style.css          # 全部样式 + 4 套主题
    └── app.js             # 主页面逻辑
```

---

## 数据库设计

三张表，全部在 `init_db()` 中创建（带旧库兼容迁移）。

### users

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| employee_id | TEXT UNIQUE NOT NULL | 工号（登录标识） |
| name | TEXT NOT NULL | 姓名 |
| password_hash | TEXT NOT NULL | `pbkdf2$100000$<salt>$<hash>` |
| cat_initialized | INTEGER | 分类初始化标记（0 = 未初始化预设） |
| created_at | TEXT | 创建时间 |

### categories（用户专属）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| user_id | TEXT NOT NULL | 所属工号 |
| name / color | TEXT | 分类名与颜色 |
| is_preset | INTEGER | 是否预设分类 |
| sort_order | INTEGER | 排序 |

### todos

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| name | TEXT NOT NULL | 待办名称 |
| category_id | INTEGER | 分类 id（可空） |
| category_name / category_color | TEXT | **分类快照**：改名/删分类不影响已有待办显示 |
| start_date / due_date | TEXT | 起止日期 |
| is_done | INTEGER | 完成状态 |
| sync_calendar | INTEGER | 是否同步到部门月历 |
| is_recurring / recur_type | INTEGER / TEXT | 循环待办标记与类型（周/月） |
| creator_id | TEXT | 创建者工号（数据隔离依据） |

---

## API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/register` | POST | 注册（工号 + 姓名 + 密码） |
| `/api/login` | POST | 登录 |
| `/api/logout` | POST | 退出登录 |
| `/api/session` | GET | 当前登录态 |
| `/api/password` | PUT | 修改密码 |
| `/api/account/delete` | DELETE | 注销账号（清空该工号全部数据） |
| `/api/todos` | GET / POST | 我的待办列表 / 新建 |
| `/api/todos/<id>` | PUT / DELETE | 编辑 / 删除 |
| `/api/todos/<id>/toggle` | PUT | 切换完成状态（循环待办在此滚动生成下一轮） |
| `/api/categories` | GET / POST | 分类列表 / 新建 |
| `/api/categories/<id>` | PUT / DELETE | 改名改色 / 删除（保留待办分类快照） |
| `/api/calendar` | GET | 部门月历（全员已同步的待办） |
| `/api/my_calendar` | GET | 个人月历（自己的全部待办） |
| `/api/reminders` | GET | 今日到期 / 逾期提醒 |
| `/api/stats` | GET | 待完成、已完成、3 天内到期、已同步数 |
| `/api/export` | GET | CSV 导出 |

---

## 一些实现细节

**分类快照**：`todos` 表同时存 `category_id` 和 `category_name/category_color` 快照。
改分类名或删分类时，已有待办显示的仍是当时的名称和颜色，不会丢信息。

**循环待办滚动**：完成后从**截止日**往后滚一个周期（周/月），并对月末做收敛
（如 1/31 → 2/28），不会因为跨月无限创建。

**并发**：SQLite 开了 WAL + `busy_timeout=30s`，页面一次并发发
`/api/todos`、`/api/stats`、`/api/reminders` 等多个请求时不会撞锁。

**幽灵登录自动登出**：`session` 里的工号在库中已不存在时（账号被注销，
或浏览器带着旧 cookie 访问了另一个数据库），自动清空 session，受保护接口
返回 401，前端跳回登录页。

**密码哈希**：PBKDF2-HMAC-SHA256，10 万次迭代，每用户独立随机盐。
旧版本用的 MD5(固定盐+密码)，`verify_password()` 兼容校验并在登录成功后
自动重算升级，老库平滑迁移无需干预。

**Session 密钥**：读环境变量 `TODO_SECRET_KEY`，没配则用随机值
（重启后已登录用户需重新登录）。不要把固定密钥硬编码进代码。

---

## 常见问题

**Q：双击 bat 后浏览器显示「无法访问此页面」？**
A：等 3 秒再刷新。Flask 启动需要几秒。长时间打不开就看命令行窗口的报错。

**Q：提示端口 5001 被占用？**
A：服务已经在运行了，直接访问 <http://127.0.0.1:5001/>。想重启，
先在任务管理器结束 `python.exe`。

**Q：怎么清空所有数据？**
A：关掉服务，删掉 `todo.db`，重新启动就是全新状态。

**Q：数据是共享的吗？**
A：`todo.db` 在**每台机器各自一份**。「部门月历」展示的是同一台服务器上的
所有人数据 —— 想让同事看到彼此的待办，大家要连同一台机器上的服务。

---

## License

MIT
