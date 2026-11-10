#!/bin/sh
# SMSToWeb · docker run example (TEMPLATE — copy and edit, never run as-is)
# The critical part is --stop-timeout=90: the app needs up to 80s to drain.
# Docker's default is 10s and will SIGKILL the process first.
#
# Docs: docs/guide/07-停止宽限与部署配置.md

docker run -d \
  --name smstoweb \
  --restart unless-stopped \
  --stop-timeout=90 \
  -p 8787:8787 \
  -e RECEIVE_TOKEN=REPLACE_WITH_A_LONG_RANDOM_STRING \
  -e ENABLE_AUTH=true \
  -e ADMIN_PASSWORD=REPLACE_WITH_ADMIN_PASSWORD \
  -e SESSION_SECRET=REPLACE_WITH_A_DIFFERENT_RANDOM_STRING \
  -e SQLITE_PATH=/data/data.db \
  -v sms-data:/data \
  smstoweb

# Verify the grace actually took effect (expect 90):
#   docker inspect smstoweb --format '{{.Config.StopTimeout}}'
# Verify the app budget in the startup log:
#   docker logs smstoweb 2>&1 | grep shutdown_grace
# Stop with an explicit timeout too:
#   docker stop --timeout 90 smstoweb
#
# Turso mode instead of local SQLite: remove SQLITE_PATH and add
#   -e TURSO_DATABASE_URL=libsql://xxx.turso.io
#   -e TURSO_AUTH_TOKEN=REPLACE_WITH_TURSO_TOKEN
