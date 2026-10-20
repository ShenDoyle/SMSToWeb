# SMSToWeb 自托管镜像（Fly.io / Railway 通用）
# 构建上下文 = platforms/node/（本目录自包含：入口 + app.js + db.js + schema.sql）
#   Turso 模式：   docker run -p 8787:8787 --env-file .env smstoweb
#   本地 SQLite：  docker run -p 8787:8787 -e SQLITE_PATH=/data/data.db -v sms-data:/data smstoweb
# Node 22：本地 SQLite 模式依赖内置 node:sqlite（22.13+）；Turso 模式无版本敏感
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.mjs app.js db.js schema.sql ./

EXPOSE 8787
CMD ["node", "server.mjs"]
