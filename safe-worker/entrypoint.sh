#!/bin/bash
# SAFE Browser entrypoint — starts Xvfb + Chromium + x11vnc + noVNC
set -e

# Virtual framebuffer (1280x720, 24-bit color)
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
sleep 1

# D-Bus (needed by Chromium)
dbus-daemon --session --fork 2>/dev/null || true

# Chromium in kiosk mode
chromium-browser \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --no-first-run \
  --start-maximized \
  --window-size=1280,720 \
  --user-data-dir=/home/user/.config/chromium \
  "about:blank" &
sleep 2

# VNC server (password from env)
mkdir -p /home/user/.vnc
x11vnc -storepasswd "${VNC_PW:-sentry}" /home/user/.vnc/passwd
x11vnc -display :99 -rfbauth /home/user/.vnc/passwd -forever -shared -noxdamage -rfbport 5900 &
sleep 1

# noVNC WebSocket proxy (port 6901 → VNC port 5900)
/opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6901 &

echo "[SAFE] Browser ready on port 6901"

# Keep alive
wait -n
