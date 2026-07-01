FROM node:22-slim
WORKDIR /app
COPY . .
RUN corepack enable && (pnpm install --frozen-lockfile || npm install)
EXPOSE 8787
CMD ["npx", "tsx", "src/server.ts"]
