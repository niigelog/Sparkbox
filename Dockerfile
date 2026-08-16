# 只装后端要用的东西：server + 迁移。插件是在开发机上 esbuild 打包的，不进镜像。
FROM node:22-alpine

WORKDIR /app

# 先装依赖再拷源码，改代码时这一层还能命中缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY db ./db
COPY scripts/migrate.mjs ./scripts/migrate.mjs

# 别用 root 跑
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7000

EXPOSE 7000

CMD ["node", "server/index.mjs"]
