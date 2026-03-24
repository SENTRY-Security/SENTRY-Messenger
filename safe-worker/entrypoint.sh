#!/bin/bash
# SAFE Browser entrypoint — starts Xvfb + Openbox + Chromium + x11vnc + noVNC
# NOTE: no "set -e" — individual failures must not kill the container.
# The critical process is novnc_proxy (port 6901); it runs in foreground
# so the container stays alive as long as noVNC is up.

# Virtual framebuffer (1280x720, 24-bit color)
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
sleep 1

# D-Bus (needed by Chromium)
dbus-daemon --session --fork 2>/dev/null || true

# Window manager — provides a desktop even if Chromium crashes.
# Openbox autostart handles launching Chromium with auto-restart.
openbox-session &
sleep 1

# VNC server (password from env)
mkdir -p /home/user/.vnc
x11vnc -storepasswd "${VNC_PW:-sentry}" /home/user/.vnc/passwd
x11vnc -display :99 -rfbauth /home/user/.vnc/passwd -forever -shared -noxdamage -rfbport 5900 &
sleep 1

echo "[SAFE] Starting noVNC on port 6901..."

# noVNC WebSocket proxy — runs in FOREGROUND via exec.
# This is the health-check target (defaultPort=6901).
# exec replaces bash with novnc_proxy so it becomes PID 1;
# the container stays alive as long as this process runs.
exec /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6901
