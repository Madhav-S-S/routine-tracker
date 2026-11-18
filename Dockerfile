FROM node:22-bookworm-slim

WORKDIR /app

# better-sqlite3 uses a native addon. These build tools are needed only at image build time.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./server.js
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/routine-tracker.sqlite
EXPOSE 3000
VOLUME ["/app/data"]
USER node
CMD ["node", "server.js"]
