# SAFE Browser Container — lightweight Chromium + noVNC
# Target: < 800MB to fit Cloudflare Containers' 2GB limit
# (kasmweb/chromium was 3.5GB — too large)
#
# Architecture:
#   Xvfb (virtual display) → Chromium → x11vnc → websockify (noVNC)
#   Port 6901: noVNC HTML5 client + WebSocket

FROM alpine:3.21

# Install Chromium, VNC server, noVNC, and minimal dependencies
RUN apk add --no-cache \
    chromium \
    xvfb \
    x11vnc \
    python3 \
    py3-numpy \
    bash \
    font-noto \
    font-noto-cjk \
    font-noto-emoji \
    dbus \
    mesa-gl \
    mesa-dri-gallium \
    && mkdir -p /opt/noVNC/utils

# Install noVNC + websockify
ADD https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz /tmp/novnc.tar.gz
ADD https://github.com/novnc/websockify/archive/refs/tags/v0.12.0.tar.gz /tmp/websockify.tar.gz
RUN tar -xzf /tmp/novnc.tar.gz -C /opt/noVNC --strip-components=1 \
    && tar -xzf /tmp/websockify.tar.gz -C /opt/noVNC/utils/websockify --strip-components=1 \
    && rm /tmp/novnc.tar.gz /tmp/websockify.tar.gz \
    && ln -s /opt/noVNC/vnc.html /opt/noVNC/index.html

# Create non-root user for Chromium sandbox
RUN adduser -D -h /home/user -s /bin/bash user \
    && mkdir -p /home/user/.config/chromium /tmp/.X11-unix \
    && chown -R user:user /home/user /tmp/.X11-unix

# Startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DISPLAY=:99
ENV VNC_PW=sentry

EXPOSE 6901

USER user
ENTRYPOINT ["/entrypoint.sh"]
