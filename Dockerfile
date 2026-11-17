# Selah in a container: the server, the reading voice, and the Claude Code
# CLI that writes the reflections.

FROM node:24-bookworm-slim

# ffmpeg turns a saved recording into a small .m4a; curl fetches Claude Code.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/library \
 && chown -R node:node /app

USER node
ENV PATH="/home/node/.local/bin:${PATH}"

# Claude Code. The installer scans the folder it is run from, so run it from a small one.
WORKDIR /tmp
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
# The voice runs on the processor; skip the download of graphics-card libraries.
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --omit=dev

# Fetch the reading voice now (about 325 MB) so the container starts ready to read.
RUN node -e "import('kokoro-js').then(({ KokoroTTS }) => KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' }))"

COPY --chown=node:node . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SELAH_IN_DOCKER=1
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server.js"]
