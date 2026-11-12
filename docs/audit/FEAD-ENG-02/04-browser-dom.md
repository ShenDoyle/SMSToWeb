# FEAD-ENG-02 · 04-browser-dom 浏览器与 DOM 兼容性（G4）

## 证据基线（Chromium/Playwright，本机 E2——注意：单一浏览器引擎，Firefox/Safari/真实设备未覆盖）

| 能力 | 证据 | 结果 |
|---|---|---|
| 首屏初始化 / 列表渲染 | A1/A2 基线 + 21 套件回归 | E2 PASS |
| markClipped（OPT-2 后语义） | 新旧算法 4 视口 40 卡 mismatch=0（d2 验收） | E2 PASS |
| 详情弹窗 / 双栏 / 触摸 / 键盘 | ux04/ux07b/ux07c/ux08 系列 | E2 PASS |
| 缩放（125% + 真实刷新路径） | d2 验收缩放用例 | E2 PASS |
| 主题切换 / 多语言 / 字体 | ux07-theme + settings-i18n + i18n 九语种检查脚本 | E2 PASS |
| ResizeObserver / 动态布局 | UX-07C split 断点监听（SPLIT_MQ） | E2 PASS（1600 断点切换） |
| 视口矩阵 | 8 视口 × Light/Dark × zh/en/ja（UX-09 j-matrix 截图） | E2 PASS |

## 缺口（D 阶段补齐）

- 引擎覆盖：仅 Chromium；Firefox/Safari 的 `webkitLineClamp`（markClipped 依赖）需真实浏览器确认——`-webkit-line-clamp` 已是全引擎标准，风险低（P3）。
- 真机触摸（Android/iOS）与安全区（env(safe-area-inset-bottom)）实际表现。
- 各平台部署后的浏览器全链路（E4）。

## 已知遗留

N-1（390px 筛选总数裁切）/ N-2（窄屏站点名截断）——P2，UX 阶段已登记，不阻塞本阶段。
