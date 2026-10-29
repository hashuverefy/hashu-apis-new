FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
