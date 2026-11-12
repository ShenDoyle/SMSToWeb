# FEAD-ENG-02 · 06-error-recovery 异常恢复与稳定性（G6）

## 证据（Node E2 为主；五平台 E0 同源）

| 异常 | 验证内容 | 证据 | 结果 |
|---|---|---|---|
| 网络中断（挂起） | 无永久 loading、不误跳登录、保留已加载列表 | UX-09 RV-1（fix5-rv，7 断言） | E2 PASS |
| 请求超时/中止 | 中文网络提示 + 重试入口 + 恢复后正常加载 | 同上 | E2 PASS |
| 401 | 整页重载 → 登录页；API 返回 unauthorized JSON | p1-auth + RV-1 | E2 PASS |
| 500 | 错误 JSON（统一 json() 封装）+ 前端失败 toast | d1（A8 no-store 复核）+ UX-08 | E2 PASS |
| DB_LOCKED | 批量操作部分失败提示 + 可重试 | m1-lifecycle + UX-09 RV | E2 PASS |
| 保存失败 | scStatus(error) + toast--error（B-发现-1 修复后） | fix6-b1 定点 7/7 | E2 PASS |
| 平台 API 异常 | serveHtml WebCrypto 失败 → 安全退化 no-cache 无 ETag | 代码路径审查（E0）+ 无法本地注入故障（如实标注） | E0 |
| 数据库暂不可用 | ensureSchema 失败不阻断 + 500 兜底 | m1-lifecycle | E2 PASS |
| 并发请求失败隔离 | load() 竞态保护（loadSeq/paneSeq），过期请求不污染 UI | UX-09 U9-11 实现 + UX-08 | E2 PASS |

## 用户可恢复性结论

所有异常路径均验证「用户实际可恢复」（重试按钮 / 重新登录 / 刷新），非仅控制台无报错。五平台 D 阶段需复验点：CDN/函数层 5xx 响应是否仍带正确 Content-Type 与安全头（E0 检查各适配层未吞 SECURITY_HEADERS）。
