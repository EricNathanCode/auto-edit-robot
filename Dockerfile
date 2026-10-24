# Auto Edit Robot: FFmpeg + a small Node.js API. Same Debian 13 as CT 100.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 autoedit \
 && mkdir /work && chown autoedit /work
WORKDIR /app
COPY render.js server.js smart.js vision.js ./
ENV WORK_DIR=/work PORT=8090 OLLAMA_URL=http://ollama:11434
USER autoedit
VOLUME /work
EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=10s CMD node -e "fetch('http://127.0.0.1:8090/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
