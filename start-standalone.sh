#!/bin/sh
# 刷B站插件 · 独立版（安卓 Termux / proot / Linux 都能跑）
# 用法：sh start-standalone.sh
cd "$(dirname "$0")" || exit 1

PORT="${BILI_PORT:-8790}"
echo ""
echo "  刷B站插件 · 独立版"
echo "  面板地址： http://127.0.0.1:${PORT}/bili-console"
echo "  ⚠️ 别同时开着 DSH 里的插件，两边都会发评论。"
echo ""

# 尽量自动打开浏览器（有就开，没有就算了，不影响服务）
( sleep 2; command -v termux-open-url >/dev/null 2>&1 && termux-open-url "http://127.0.0.1:${PORT}/bili-console" ) &
( sleep 2; command -v xdg-open >/dev/null 2>&1 && xdg-open "http://127.0.0.1:${PORT}/bili-console" >/dev/null 2>&1 ) &

exec node standalone.mjs
