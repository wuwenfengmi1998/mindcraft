#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
/bin/zsh -lc "cd \"$ROOT\" && ./scripts/start.sh"
STATUS=$?
echo
if [ "$STATUS" -eq 0 ]; then
    echo "Mindcraft 已退出。"
else
    echo "启动失败，退出码：$STATUS"
fi
read -n 1 -s -r -p "按任意键关闭窗口..."
echo
exit "$STATUS"
