# 12 · UX-14 六项调整交付 + CF ETag 方案收口

- 日期：2026-11-13
- 版本：`v1.1.4`（基线 `8c412f2` / v1.1.3）
- 范围：用户 2026-11-13 下达的 6 项产品调整；未提及的功能与界面保持不变
- 前置结论沿用：`10-live-cf-eo-analysis.md`（CF/EO 线上实测）、`11-etag-f1-rootcause.md`（F1 零发版诊断）

---

## 一、六项调整交付矩阵

| # | 需求 | 落盘位置 | 实现要点 |
|---|---|---|---|
| 1 | 收藏与置顶拆成两个独立功能 | `src/worker.js` / `schema.sql` / `tests/run.mjs` | 新增 `pinned` 列与 `idx_messages_pin_time`；独立接口 `/api/messages/pin`（`handlePinMessage`）；独立列表按钮 `.pin`、筛选 chip `#fpin`、详情按钮 `#dpin`；`starred` 只管收藏筛选，**排序改由 `ORDER BY pinned DESC, received_at DESC, id DESC`**；游标首段由 `starred` 改为 `pinned`；九语种新增 `pin/unpin/pinOnly/pinTip/pinItemTip/pinFail`，`star` 文案去掉「置顶」 |
| 2 | 「查看统计」→「统计」 | `src/worker.js` | 九语种 `viewStats` 统一改为「统计」/对应本地化短词；HTML 两处静态按钮 `data-i18n="viewStats"` 同步改字 |
| 3 | 设备移入设置、单独 tab | `src/worker.js` / `tests/ux02-layout.mjs` | 删除顶栏 `#devbtn`、移动端 `#mnudev`、`openDevices()` 弹层；`SET_SECTIONS` 新增 `{ key: "devices" }`；新增 `deviceRowsHtml()` / `deviceAction()` / `scBodyDevices()` / `scRefreshDevices()`；`scRenderBody()` 增分支、`scSectionActions()` 对该 tab 隐藏「保存/恢复默认」；设备操作即时生效后**就地重绘 tab、不再关闭设置弹层**；九语种新增 `scTabDevices / scSecDevicesHelp / scDevicesEmpty` |
| 4 | 删除「仅保存在当前浏览器」类说明文案 | `src/worker.js` / `tests/run.mjs` | `scSecDisplayHelp`、`scSecMessagesHelp`、`scHomeStatsScope`、`scBrowserPrefsHelp`、`scLangHelp`、`scPageSizeHelp` 九语种置空；`scHead()` 在 desc 为空时不渲染 `<p>`；`scBodyDisplay()` 用 `filter(Boolean).join(" ")`。**仅删文案，localStorage 存储与同步行为零改动** |
| 5 | 详情卡片右侧验证码 + 复制按钮 | `src/worker.js` | `detailHTML()` 生成 `.detail-code` 右栏（弹层与宽屏面板共用同一渲染层 → 所有含码详情都覆盖）：`dc-label` + `dc-value` + `#dccopy`；样式为等宽字体、24px/700 字重、2px 字距、`--ds-code-*` 强调色；`bindDetail()` 读取 `.dc-value` 调 `doCopy()`；无验证码消息仍是原单栏 `.detail-body`，布局不变；窄屏（≤660px）降级为横向堆叠 |
| 6 | `sms-gateway.jexsef.workers.dev` ETag 支持 + CF 官方文档分析 | 本报告第三～六节 | **结论：放弃该 ETag 相关方案，保持现状**，不阻塞其余 5 项；详见下文 |

### 改动文件清单

| 文件 | 变更 |
|---|---|
| `src/worker.js` | 主源：六项逻辑、i18n、CSS、版本号 `v1.1.3 → v1.1.4` |
| `schema.sql` | `pinned` 列 + 索引 + 主排序注释 |
| `platforms/{shared,cloudflare,edgeone,vercel,netlify,deno,node}/*` | `gen_app.py` 同步产物（含 `SCHEMA_SQL` 内嵌块） |
| `tests/run.mjs` | 适配 pinned 排序/游标、说明文案断言，新增六项需求验收断言（859 项） |
| `tests/ux02-layout.mjs` | C1/C2 改为「设备入口已移除、迁入设置 tab」，新增 C4 就地刷新断言（59 项） |
| `docs/audit/FEAD-ENG-02/12-*.md` | 本报告 |

---

## 二、验证结果（v1.1.4）

| 检查 | 结果 |
|---|---|
| `node --check src/worker.js` | 通过 |
| `python platforms/gen_app.py` + `--check` | 六平台产物零漂移；`SCHEMA_SQL` 与根 `schema.sql` 一致；schema 引用校验通过 |
| `node tests/run.mjs` | **859 通过 / 0 失败** |
| `tests/p1-auth.mjs` | 23 / 0 |
| `tests/settings-i18n.mjs` | 64 / 0 |
| `tests/ux02-layout.mjs` | 59 / 0 |
| `tests/ux03-settings.mjs` | 47 / 0 |
| `tests/notify-sensitive-fields.mjs` | 51 / 0 |
| `tests/etag-fallback.mjs` | 13 / 0 |
| **合计** | **1116 通过 / 0 失败** |

`npm run test:browser`（Playwright 三套）本机未安装 `playwright` / Chromium，本轮未执行；CI 工作流包含该步骤。

---

## 三、第 6 项：`sms-gateway.jexsef.workers.dev` 实测

```
$ curl -sSI https://sms-gateway.jexsef.workers.dev/
HTTP/1.1 502 Bad Gateway
Connection: close
Retry-After: 1
Content-Length: 46
Content-Type: text/plain; charset=utf-8
```

该 `workers.dev` 子域当前返回 502，**没有可用的 Worker 响应可供对照**，因此无法用它验证「绕过 Zone 规则后 ETag 是否出现」（这正是报告 11 第五节列的「一锤定音实验」）。此路不通，但**不影响判定**：报告 11 已用零发版诊断独立证明——

| 站点 | 响应头 ETag | 本地复算 SHA-256 | 用本地指纹发 `If-None-Match` |
|---|---|---|---|
| EO | 有，且与本地复算一致 | ✓ | **304 / 0 字节** |
| CF 自定义域名 | **无** | ✓ | **304 / 0 字节** |

即 CF 上的 Worker **确实算出了正确的强 ETag，且 304 判断逻辑正常**，只是响应头在返回客户端前被边缘/Zone 层剥离。问题在平台侧，不在应用代码。

---

## 四、Cloudflare 官方文档核对（2026-11-13 抓取）

| 来源 | 官方原文要点 |
|---|---|
| [Cache Rules settings → Respect Strong ETags](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/) | “Turn on or off byte-for-byte equivalency checks between the Cloudflare cache and the origin server. When enabled, Cloudflare will use strong ETag header validation… **If disabled, Cloudflare converts ETag headers into weak ETag headers.**” API 字段 `respect_strong_etags`（boolean） |
| [Workers Runtime APIs → Cache](https://developers.cloudflare.com/workers/runtime-apis/cache/) | 响应头 `ETag`：“Allows `cache.match()` to evaluate conditional requests with `If-None-Match`.”；请求头 `If-None-Match`：“Results in a `304` response if a matching response is found with an `ETag` header with a value that matches…” 并明确 Cache API 与 CDN 缓存是**两套独立机制** |
| [Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/) | “When setting `no-cache` with Origin Cache Control off, Cloudflare does not cache. When setting `no-cache` with Origin Cache Control on, Cloudflare caches and always revalidates.”；`Vary`：“By default, Cloudflare does not consider vary values in caching decisions.” |
| [Default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) | `Cache-Control: no-cache` 属于「不缓存」条件之一；“**The Cloudflare CDN does not cache HTML or JSON by default.**” |

### 由官方文档得到的关键判断

1. CF 官方口径是「**强 ETag 转弱**」，而本例观测是「**完全没有 ETag**」。两者不完全吻合，说明除 `respect_strong_etags` 之外，Zone 层还存在移除响应头的动作（Transform Rules / 前置代理 Worker / 边缘规则）。这属于 Zone 配置，应用代码无法自证或覆盖。
2. 本应用返回的是**认证态动态 HTML**：`Cache-Control: no-cache` + `Vary: Cookie`。按官方默认行为，这类响应不入 CF 边缘缓存，且 CF 默认不缓存 HTML/JSON。因此「靠 ETag 在 CF 边缘完成 304 省流」这条链路，在 CF 上本就不在默认缓存路径里。
3. 若要强行打通，需要同时：开启 Cache Rules 的 `Respect Strong ETags`、显式配置 `Vary`、让认证页面可缓存、排查剥离头部的 Transform Rules。其中「认证页面进共享缓存」与现有 `Vary: Cookie` 隔离设计直接冲突，存在**串号风险**，收益（约 28KB/次省流）远小于风险与配置成本。
4. Workers Cache API 的 `ETag`/`If-None-Match` 能力是**另一套机制**（`caches.default`），本项目未使用它，也不适合认证 HTML。

---

## 五、决策：放弃该 ETag 方案，保持现状

按用户指示执行，**不为 ETag 阻塞其余调整**：

- **放弃**：不再尝试让 CF 自定义域名返回强 ETag，不再为此改应用代码、不再追加诊断发版。
- **保持现状**：
  - `serveHtml()` 的 SHA-256 强 ETag + `If-None-Match → 304` + `no-cache` + `Vary: Cookie` 全部保留；
  - v1.1.3 的 `jsEtag` 纯 JS 降级与 `etag_digest_fallback` warn 日志**保留不回滚**——它保障的是「WebCrypto 不可用时仍不丢 ETag」，属独立健壮性价值，与 CF 是否透传 ETag 无关；
  - `tests/etag-fallback.mjs` 13 项继续留在 `test:node` 与 CI。
- **实际影响**：页面 200 正常、登录态隔离不变、功能无损；EO 平台 ETag + 304 省流继续生效；仅 CF 侧浏览器拿不到 ETag，每次回源约 28KB 全量响应（省流优化失效）。**当前线上使用不受影响**。
- **闭环状态**：F1 从「应用缺陷」改判为「平台配置差异」后，代码侧已闭环；平台侧排查不再列入当前迭代的阻塞项。

---

## 六、后续（非本轮）

- U1–U10 六平台统一验收用例（`09-test-plan.md`）按用户指示推迟到 **2.0.0 正式版**再做；本轮线上是真实在用的生产部署，不做大范围真实评测。
- 若 2.0.0 前决定恢复 CF 省流，只在 CF 控制台侧处理：Cache Rules → `Respect Strong ETags`、Transform Rules 响应头排查、`Vary` 配置；顺序见 `11-etag-f1-rootcause.md` 第五节。**该动作需控制台权限，由用户侧执行，不进应用代码。**


---

## 七、v1.1.5 · 按 EditHere 标注修正 UX-14（R2）

用户在 EditHere 对当前样式图（A 列表卡片 / B 信息详情）提交 5 条批注，判定 v1.1.4 把「信息详情卡片」误读成了详情弹层。本轮按批注重做，其余功能与界面不变。

| 批注 | 标注内容 | 落地 |
| --- | --- | --- |
| ① | 「验证码是为了方便，大部分人是右手操作，放右边。这里的复制按钮受设置里的影响」；组件从左下 `(58,178)-(132,207)` 移到右侧 `(920,182)-(994,211)` | `cardHtml()` 把 `.code-chip` 从 `.msg-foot` 移入 `.msg-rail` 下方的 `.rail-code`；`.msg-rail` 改为 column + `align-self:stretch` + `space-between`，操作按钮在上、验证码在卡片右下。胶囊自带复制按钮**仍由 `state.codeCopy` 控制**，行为不变；窄屏仍绝对定位右下并按 `:has(.rail-code)` 预留脚注高度。 |
| ② | 「去掉这个东西，恢复到上个版本」（指向详情右侧 24px 大号验证码） | 删除 `.detail-code` / `.detail-main` 及全部相关 CSS 与窄屏规则，`detailHTML()` 恢复 v1.1.3 的单栏 `.detail-body`。 |
| ③ | 「没有验证码的时候，删除键在最右边，有验证码的时候，删除键被验证码复制键往左边挤一个位置」 | `actsEnd` 改为 `dunread → ddel → [dccopy if code]`：无码时删除仍在最右；有码时最右多一个复制按钮，删除左移一位。 |
| ④ | 「标记未读放删除键左边」 | `actsEnd` 顺序由 `ddel, dunread` 调整为 `dunread, ddel`。 |
| ⑤ | 「这里放复制验证码按钮，不受设置里的影响」 | `#dccopy` 仅由 `code` 是否存在决定，**不读取 `state.codeCopy`**；点击直接复制 `extractCode(m.content)`。弹层与宽屏面板共用同一 `actsEnd`，所有含码详情都有该按钮。 |

**说明**：反馈 JSON 的 `image.sha256` 与本地 PNG 不同（EditHere 重新编码），但尺寸 1060×640、文件名与全部批注坐标均与预览图一致，按同一画面处理。详情弹层原有的「关闭」按钮保留在按钮组最后（预览图用右上角 × 表示，未标注该项）。

**验证**：`gen_app.py` 零漂移、全量 Node 回归全绿；`APP_VERSION` → `v1.1.5`。

## 八、v1.1.6 · 移动端多选按钮遮挡根治（R3）

**背景**：重拍 README 英文截图时发现，390px 视口下工具栏 `Multi-select` 会盖住 `Starred` chip 尾部；当时把移动端截图视口临时调到 430px 规避。用户要求根治，本轮把视口恢复为 390px。

### 根因

`@media (max-width: 660px)` 里为保住首屏密度，把多选按钮绝对定位到标签行右端，并给 `.filter-tabs` 写死 `padding-right: 58px` 留白。58px 只够中文「多选」；`Multi-select`(84px)、`Sélection multiple` / `Mehrfachauswahl`(120px) 明显更宽，按钮背景直接压在末尾 chip 上。

### 修复

- `.toolbar` 改为两列网格：`grid-template-columns: minmax(0, 1fr) auto`；`.filters { display: contents; }`；标签占第 1 列（保留 `overflow-x:auto` 横滑），按钮按**真实内容宽度**占第 2 列，`.filter-row` 跨两列占第 2 行。按钮回到文档流，任何语言都不会重叠，首屏仍是两行、高度不变。
- 删除 `position: absolute` 与 `padding-right: 58px`；保留 `.toolbar { position: relative }` 原有定位上下文。
- 附带修复：`.toolbar-title` 内 `.sr-only` 是未指定 `left/top` 的绝对定位元素，包含块落在滚动容器之外，停在 x≈409 并给 document 撑出 **20px 横向滚动**（`scrollWidth 410 / clientWidth 390`）。就近设 `.toolbar-title { position: relative; }` 使其被 `.filter-tabs` 裁剪，横向滚动归零。

### 验证（CDP 真实渲染，390×844，九语种逐个替换按钮文案实测矩形）

| 语言 | 按钮宽 | 标签右缘 / 按钮左缘 | overlap | scrollWidth / clientWidth |
| --- | --- | --- | --- | --- |
| zh-CN / zh-TW | 44px | 313 / 321 | 0 | 390 / 390 |
| en | 84px | 273 / 281 | 0 | 390 / 390 |
| ja / ko | 70 / 74px | 287 / 283 | 0 | 390 / 390 |
| es / pt | 100 / 113px | 257 / 244 | 0 | 390 / 390 |
| fr / de | 120px | 237 / 245 | 0 | 390 / 390 |

按钮右缘恒为 365（视口 390 内），`overlap=0` 全覆盖，9/9 通过。脚本：`readme-shots/verify-r3.mjs`。

- `tests/run.mjs` 新增 R3 结构断言（网格列、无绝对定位、无 58px、`.toolbar-title` 定位）。
- `gen_app.py --check` 六平台零漂移；全量 Node 回归 **1119 通过 / 0 失败**（862+23+64+59+47+51+13）。
- 6 张 README 截图按 v1.1.6 + 390px 重拍；README 截图说明同步为 v1.1.6 并注明 390px 视口。
- `APP_VERSION` → `v1.1.6`。

**取舍**：按钮变宽时标签可视区相应收窄，`Starred` / `Pinned` 需横向滑动查看——`.filter-tabs` 本身就是横滑容器，chip 完整可点、不被覆盖。若要求 390px 下同时看到全部 chip，需把多选入口改成图标或移到别处，属界面改动，本轮未做。
