# FEAD-ENG-02 · 05-business-data 业务数据一致性（G5）

## 证据（Node E2 + 结构测试；其余平台 E0 同源）

| 场景 | 证据 | 结果 |
|---|---|---|
| 短信接收（JSON/表单/文本/query 多格式） | m1-lifecycle + p1-auth 附带 | E2 PASS |
| 分页 / 游标连续性 | A2 翻页实测（10→5000 条，无丢页）+ cursor SQL 快照一致性设计（L1468-1484 注释） | E2 PASS |
| 搜索 / 来源筛选 / 设备分组 | ux08-flows + A2 延迟项 | E2 PASS |
| 星标 / 已读 / 删除（软删除+撤销） | UX-09 fix1/fix3/fix4 专项 | E2 PASS |
| 多选 / 批量已读 / 批量删除部分失败 | ux08-browser（bulkPartial 提示） | E2 PASS |
| 通知发送 / 多目标一成一败 | UX-09 RV-3（success/error 各归其位） | E2 PASS |
| 并发写入 / 消息不重不丢 | m1-lifecycle（幂等去重 + DB_LOCKED 重试） | E2 PASS |

## 五平台风险点（E0 → D 阶段验证）

1. **DB 方言**：D1（Cloudflare）vs node:sqlite vs Turso（libsql）——db.js 适配层各自实现；SQL 兼容性由 SCHEMA_SQL 幂等自愈保证（E0），但**游标分页 SQL 在 Turso/D1 的行为需真实数据量下验证**（P2 关注）。
2. **调度差异**：CF crons 已配置；node 内置定时 E2 通过；vercel/netlify/deno/edgeone 依赖平台 cron 或 `/api/cron?token=` 手动触发——若用户未配置平台调度，保留期清理静默不执行（P2，建议 README 已有说明，D 阶段核对）。
3. **通知外呼**：fetch 出站（webhook）在五平台的并发/超时行为——业务码统一（E0），D 阶段抽样。
