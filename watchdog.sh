#!/bin/bash
# Restart dev server if it dies. Max 1 instance.
while true; do
  if ! pgrep -f "next dev -p 3000" >/dev/null 2>&1; then
    pkill -f "next dev" 2>/dev/null
    sleep 1
    cd /home/z/my-project
    bun run dev >> /home/z/my-project/dev.log 2>&1 &
    echo "[$(date +%H:%M:%S)] restarted dev server" >> /home/z/my-project/watchdog.log
  fi
  sleep 8
done
