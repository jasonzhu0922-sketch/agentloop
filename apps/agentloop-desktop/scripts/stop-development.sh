#!/usr/bin/env bash
set -eu

# Stop the fixed-port development host before rebuilding or starting another
# instance. Do not force-kill active Runs or remove their instance lock.
command -v lsof >/dev/null || { echo "重启 Desktop 需要 lsof。" >&2; exit 1; }
desktop_pids="$(lsof -tiTCP:8796 -sTCP:LISTEN || true)"
if [ -z "$desktop_pids" ]; then
  echo "Desktop 未运行，准备构建并启动。"
  exit 0
fi

for desktop_pid in $desktop_pids; do
  echo "正在停止 Desktop（PID ${desktop_pid}）…"
  kill -TERM "$desktop_pid" || exit 1
done

for attempt in {1..30}; do
  desktop_running=false
  for desktop_pid in $desktop_pids; do
    if kill -0 "$desktop_pid" 2>/dev/null; then desktop_running=true; fi
  done
  if [ "$desktop_running" = false ]; then
    echo "旧 Desktop 已退出。"
    exit 0
  fi
  sleep 1
done

echo "旧进程尚未退出，请先结束或取消正在执行的任务，再重试；本次不会复用旧进程。" >&2
exit 1
