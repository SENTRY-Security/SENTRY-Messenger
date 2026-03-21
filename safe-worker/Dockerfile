# SAFE Browser Container — KasmVNC Chromium
# Runs on Cloudflare Containers (linux/amd64, gVisor sandbox)
#
# KasmVNC serves its HTML5 client + WebSocket on port 6901.
# The CF Worker proxies WebSocket connections to this port.

FROM kasmweb/chromium:1.18.0

# Default password — overridden by envVars in Container class
ENV VNC_PW=sentry

# KasmVNC WebSocket port
EXPOSE 6901
