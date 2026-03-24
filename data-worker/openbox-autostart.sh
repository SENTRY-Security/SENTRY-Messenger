#!/bin/bash
# Openbox autostart — launch Chromium with auto-restart on crash

while true; do
  chromium-browser \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --no-first-run \
    --start-maximized \
    --window-size=1280,720 \
    --user-data-dir=/home/user/.config/chromium \
    "about:blank"
  # Chromium exited — wait 2s then relaunch
  sleep 2
done &
