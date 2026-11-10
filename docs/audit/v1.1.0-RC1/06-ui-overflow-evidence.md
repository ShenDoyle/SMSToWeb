# 附件 A · Phase 6 UI/UX 多终端溢出证据

## 取证方法

1. 从 `src/worker.js` 抽取 `LOGIN_HTML`（:7499 附近）与 `PAGE_HTML`（:2160 附近）模板（`String.raw` 块）。
2. 离线等价替换服务端令牌：`__SITE_NAME__`→SMSToWeb、`__APP_VERSION__`→v1.1.0、`__SITE_ICON__`→""、`__SITE_NAME_JSON__`→`"SMSToWeb"`，并注入 `DS_TOKENS_CSS`（设计令牌 `:root` 变量），使渲染忠实于运行时。
3. 注入 `ovfScript`：在 `</body>` 前插入红色横幅，显示 `SW=scrollWidth IW=innerWidth OVF=(scrollWidth>innerWidth)`。
4. 用 Microsoft Edge `--headless=new` 渲染并截图（5 视口）。
5. **真值修正**：headless 直接 `--window-size=320/390` 会把布局视口 inflate 到 ~482px（不尊重请求宽度），故额外用固定像素 `<iframe width=320/390>` 嵌入页面，使页面媒体查询与 `innerWidth` 解析为**真实移动宽度**，再读横幅。

## 溢出 Ground Truth（文档 scrollWidth vs innerWidth）

| 视口 | 方法 | IW | OVF | 文件 |
|---|---|---|---|---|
| 1920 | 直接 | ≈1896 | false | `screenshots/login-1920.png`、`page-1920.png` |
| 1366 | 直接 | 1342 | false | `screenshots/login-1366.png`、`page-1366.png` |
| 768 | 直接 | 744 | false | `screenshots/login-768.png`、`page-768.png` |
| 390 | iframe 真值 | 390 | false | `screenshots/host_login_390.png`、`host_page_390.png` |
| 320 | iframe 真值 | 320 | false | `screenshots/host_login_320.png`、`host_page_320.png` |

## 视觉复核（320px）

- 登录页：白卡居中，标题 SMSToWeb、密码框（管理密码）、绿色「登 录」按钮均在视口内，无溢出/重叠，页脚「© 2026 左立方 · SMSToWeb v1.1.0」在卡内。
- 管理页：头部（SMS 徽标 + 标题 + 自动 + 设置）、筛选 chips、搜索 + 来源/时间下拉、空列表占位、分页（‹ › + 页码 + 跳转）均在视口内，无水平溢出，无重叠；底部下一卡片被正常竖向滚动裁切（非缺陷）。

## 早期 false positive 澄清

前期视觉模型在「直接 --window-size 320/390（实际渲染 ~482px）」截图上报告的「卡片右侧溢出、输入框被切」经 iframe 真值横幅核实为 **OVF=false**，确认为视觉误读 + headless 视口未生效所致，非真实布局缺陷。

## 动态交互（NOT TESTED）

登录态流程、列表数据加载、详情弹窗、设置保存、通知测试发送、导出、设备管理、PWA 安装等依赖真实后端，RC1 禁止部署/连生产，故标记 NOT TESTED，建议发布前补真实浏览器 smoke test（见主报告 §13）。
