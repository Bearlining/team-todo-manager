#!/usr/bin/env bash
# 团队待办管理系统 —— macOS / Linux 启动脚本
#
# 用法：
#   ./start.sh            启动服务（前台运行，Ctrl+C 停止）
#   ./start.sh --install  先装依赖再启动
#
# Windows 用户请用 启动待办.bat，或直接：
#   pip install -r requirements.txt && python app.py

set -e
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
if ! command -v "$PY" >/dev/null 2>&1; then
    PY=python
fi
if ! command -v "$PY" >/dev/null 2>&1; then
    echo "找不到 python，请先安装 Python 3.8+"
    exit 1
fi

# 依赖检查
if ! "$PY" -c "import flask, flask_cors" >/dev/null 2>&1; then
    echo "[依赖] 检测到缺少 flask / flask-cors，正在安装..."
    "$PY" -m pip install -r requirements.txt
fi

# 端口占用检查
PORT=5001
if command -v lsof >/dev/null 2>&1 && lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[提示] 端口 $PORT 已被占用 —— 服务可能已在运行。"
    echo "       直接访问 http://127.0.0.1:$PORT/ 即可。"
    exit 0
fi

# 局域网 IP
LOCAL_IP=$("$PY" - <<'PYEOF'
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(('8.8.8.8', 80))
    print(s.getsockname()[0])
    s.close()
except Exception:
    print('127.0.0.1')
PYEOF
)

echo "=================================================="
echo "   团队待办管理系统 启动中..."
echo "=================================================="
echo "   本机访问: http://127.0.0.1:$PORT/"
echo "   内网访问: http://$LOCAL_IP:$PORT/"
echo "=================================================="
echo "   Ctrl+C 停止服务"
echo "=================================================="

exec "$PY" app.py
