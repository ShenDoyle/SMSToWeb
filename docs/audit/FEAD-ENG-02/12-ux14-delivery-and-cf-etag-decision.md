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

---

## 九、UX-17：首页卡片操作区（v1.1.7，2026-11-13）

**用户标注**（移动端 390px 截图，三张卡片红框）：「下面卡片的按钮显示也是乱的，除了删除和关闭按钮，其它的按钮太乱了，需要重新设计。」

**病因（代码事实，不是观感）**

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 操作行与设备脚注落在同一水平线，读成「· 芯引擎 ☆ 📍 删除」 | `.msg-rail` 在窄屏 `position:absolute; right/bottom:4px`，完全脱离文档流 |
| 2 | 有码卡片正文下方一大片空白，胶囊吊在卡片底边 | `.card:has(.rail-code) .msg-foot { min-height: 84px }` 固定让位 |
| 3 | 一行里三种视觉重量 | 星是字符 `☆/★`、钉是彩色 emoji `📍/📌`、删除是文字，emoji 跨设备字形不可控 |
| 4 | 「查看详情」纯文字按钮与图标混排 | `.more` 在正文超 2 行时显形，仍是文字按钮 |

**外部意见（ChatGPT，本轮原文 `ego/ux08-gpt-20261112-1730/reply-ux17-card.md`）**

1. 移动端操作区必须进文档流，独立一行 36–40px，统一单色线性图标，禁止文字符号与 Emoji，删除放最右用红色图标；
2. 验证码胶囊放正文下方、设备脚注上方，左对齐正文起点，30–32px，无码不渲染、不预留空间；
3. 桌面端保持现状（右侧操作列，按钮在上、验证码在下），只统一图标风格。

**落地与对建议的两处偏离（记录理由）**

- 采纳 1（进文档流、线性图标、删除最右）与 3（桌面不动）。
- 偏离 2 的「胶囊独占一行」：实测 390px 下设备名 + 胶囊 + 图标同处一行仍有 336px 可用宽度（63+127+120+间距），独占一行会让每张有码卡片多出约 30px 高度、卡片节奏变散。改为**三块同一行**：设备（左）· 胶囊 · 图标（右），高度统一 40px。
- 偏离 1 的「保留查看详情」：窄屏点击正文即开详情，箭头图标在手机上只是含义不明的噪声，`≤660px` 隐藏 `.more`。

**实现要点**

- 窄屏 `.card` 改 `flex` + `flex-wrap`，`.msg-main` / `.msg-rail` 双 `display:contents`，让 `msg-top / content / msg-foot / rail-code / msg-actions` 成同级 flex item，用 `order 10/20/30/40/50` 排布；桌面端 `.msg-rail` 仍是右列（`align-self:stretch`）。
- `.msg-foot { flex: 1 1 0 }`：basis 取 0，设备名再长也只走 ellipsis，不会把图标组挤到第二行（首版用 `flex:0 1 auto` 时 flex-wrap 按 basis 断行，长设备名会把图标挤下去）。
- 胶囊与图标格同高 40px（原胶囊 46px），否则一行里 46/40 参差。
- 多选态：勾选框 `flex:0 0 20px` 占最左，设备名暂时不渲染（否则被压成「Pixe…」）。

**验证**

- CDP 真实渲染 390×844：卡片高度 187 → 147（有码）/ 187 → 121（无码），`scrollWidth 390 = clientWidth`，无横向溢出；设备、胶囊、三个图标基线同为 y≈301 一行。
- 桌面 1366×900：卡片高度 98/84 与改前一致，`.msg-rail` x=1088 不变，仅按钮宽度 119 → 94（图标格）。
- 回归：`867 + 13 + 43 + 37 + 36 + 60` 全绿；`gen_app.py --check` 零漂移。
- 顺带修：`ux07-tokens` G1 的硬编码色值白名单原来写死行号区间，CSS 增行后把邮件模板挤出白名单产生假阳性，改为按内容锚点计算区间。

---

## 十、UX-18：窄屏工具栏去横滑 + 验证码胶囊移到最右（v1.1.8，2026-11-13）

**用户标注**（390px 截图两处红框）
1. 工具栏第一行被截断、需要横向拖动：「我不想要滚动实现的，多选在移动端或者触屏的显示器上，大家都有一些操作习惯，长按进入多选，可以把按钮隐藏。」
2. 卡片底部验证码胶囊在图标左侧：「验证码按钮是一个使用的快捷方式……现在放在左边失去了方便快捷的高频使用的意义，应该放到最右边。」

**病因**

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 标签行横滑、Starred/Pinned 在视口外 | UX-14-R3 为容纳「多选」按钮把 `.filter-tabs` 设为 `nowrap + overflow-x:auto`；5 个标签 + 统计文案 ≈ 419px > 390 可用宽 |
| 2 | 按钮是长按之外的冗余入口 | 手机上长按/右键早已实现同一语义（U9-19），工具栏文字按钮只占位置 |
| 3 | 「总计 N」挤在标签行尾部 | `.toolbar-title` 与标签同处一个 flex 容器，且与 statbar 重复 |
| 4 | 验证码在图标左边 | UX-17 沿用了「设备 · 胶囊 · 图标」的旧序，高频动作落在中段 |

**方案**

- **去掉横滑**：窄屏 `#selmodebtn { display:none }`；`.filter-tabs` 回到 `flex-wrap:wrap`、`overflow:visible`，`gap 5px`、chip `padding 0 10px`。多选入口保留两条：长按卡片 / 右键（既有语义不变），以及 ⋯ 菜单新增的「多选」（键盘与读屏可达）。
- **标签瘦身**：`★ 收藏` / `📌 置顶` 拆成 `.chip-ico`（16px 线性星/图钉 SVG）+ `.chip-lbl`，窄屏隐藏文案、保留 `title` / `aria-label`。九语种 `starOnly` / `pinOnly` 字符串里的字符图标一并去掉，避免「图标 + 文字」重复。五个标签在 390 下 290px 排进一行。
- **右移高频动作**：`order` 改为 设备 30 / 图标组 40 / 胶囊 50，胶囊 `margin-left:8px`、`justify-content:flex-end`。设备脚注仍 `flex:1 1 0` 吃掉剩余宽度。
- **320px 收口**：`≤360px` 时有码卡片隐藏设备名（详情弹层仍有）、胶囊与复制按钮内边距收紧、`.msg-top` 间距 5px 且号码可省略。修掉长期存在的 4px 横向溢出（`docW 324 → 320`，溢出元素是带 Notification 徽章的标题行）。
- **焦点回退**：`setSelectMode(false, {focusFrom})` 里对 `display:none` 的元素调 `focus()` 会静默失败，改为退回列表首张卡片。

**验证**

- 390×844：`docW == clientWidth == 390`，标签一行 5 个，卡片高度 147（有码）/121（无码），胶囊右边缘 363 = 卡片内容右边界。
- 320×760：`docW 320`（改前 324），卡片高度 147，胶囊仍在最右。
- 1366×900：`.msg-rail` 仍为右列，卡片高度 98/84 不变。
- 回归：`868 + 13 + 43 + 37 + 36 + 60` 全绿；`gen_app.py --check` 零漂移。
- 遗留（本轮未改，已记录）：1366 宽下工具栏第二行只放「多选 + 刷新」，UX-09 引入按钮后即如此；
  `.toolbar` 内容 1199px > 可用 1070px，需要重排控件才是一行。

**补记（同日，320 收口）**：五个视图标签在 320 仍差 16px 换行，`.filter-row` 的搜索框最小宽度
还把「筛选」按钮挤到下一行。`≤360px` 再收一档：工具栏左右内边距 12→10、标签 `gap 4px`、
chip `padding 0 8px`（命中区高度仍 44px）、搜索框 `flex:1 1 0; min-width:0`。
实测 320：标签 270px 排进 274px 一行，搜索与「筛选」同一行，`docW == 320`。

---

## 十一、UX-19：桌面工具栏单行 + 标签去图标 + 九语种分别收紧（v1.1.9，2026-11-13）

**用户标注**（桌面中文截图，红框圈住「收藏 / 置顶」两个标签与「来源 / 时间」两个下拉）
> 「像这样做成一行，然后收藏和置顶的按钮去掉icon。来源和时间那里空白太多了。不同语言针对性做一下调整」

**病因**

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 1366 下「多选 + 刷新」被挤到第二行 | 全局残留 `.toolbar, .pager { flex-wrap: wrap }`（pager 分页需要换行，工具栏不需要）；工具栏内容 1199px > 可用 1070px |
| 2 | 标签挂图标后变宽 | UX-18 给收藏/置顶加了 `.chip-ico`（图标 + 文案），每个标签 +19px |
| 3 | 来源/时间下拉里有大段空白 | `select` 宽度由最长选项撑开（115/116/107px），而实际展示的只是「来源 / 时间」 |
| 4 | 「N 条」计数占位 | `.toolbar-title` 与「全部 (N)」下拉、分页行的「共 N 条」三处重复 |
| 5 | 长文案语种更糟 | 德语 Mehrfachauswahl / Angeheftet、西语 Multiselección 比中英长 30–50%，单行所需宽度直接爆掉 |

**方案**

- **单行**：`≥901px` 起 `.toolbar / .filters / .filter-tabs / .filter-row` 全部 `nowrap`，搜索框 `flex: 1 1 120px` 做唯一伸缩项；`.filter-row` 的 `flex-basis` 归 0，宽度全部让给搜索。
- **计数让位**：桌面隐藏 `#stat`（`.toolbar-title` 的 `.sr-only` 标签保留）。
- **下拉限宽**：设备 108、来源 84、时间 84；长文案语种 80，德语 76。
- **去图标**：删除 `.chip-ico` 标记与样式，收藏/置顶回到纯文字，窄屏也不再只留图标。
- **分语言**：
  | 语种 | 调整 |
  | --- | --- |
  | de / es / fr / pt-BR | 标签字号 11.5px、内边距 8px；下拉 80（de 76） |
  | de / es / fr / pt-BR，≤1100 | 刷新按钮收成纯图标（`title` + 新增 `aria-label`） |
  | ko | 标签内边距 9px |
  | 全部 | 「多选」按钮文案缩写为单词式（Select / Auswahl / Sélection / Selección / Seleção / 選択 / 선택），`selectHint` 同步改写 |

**验证**（真实 Edge 渲染，`?lang=` 逐语言加载）

| 宽度 | 结果 |
| --- | --- |
| 1366 | 9 语种全部单行；搜索框 182（de）– 320（zh-CN）px |
| 1024 | 9 语种全部单行；搜索框 143（en）– 224（zh-CN）px |
| 901 | 9 语种全部单行，搜索框压到最小 88px，无横向溢出 |
| 390 / 320 | 标签 5 个一行（纯文字），搜索与「筛选」同行，卡片底部「设备 · 图标 · 验证码（最右）」不变 |

回归：`870 + 13 + 43 + 37 + 36 + 60` 全绿；`gen_app.py --check` 零漂移。

**踩坑**：CSS 注释里写了反引号包住的 `.toolbar` 选择器，直接把 `String.raw` 模板字符串截断，
六平台产物一起语法报错。注释里不要出现反引号。

---

## 十二、版本号收敛：本轮全部改动合并为 v1.1.7（2026-11-13）

UX-16 / UX-17 / UX-18 / UX-19 四轮迭代过程中曾把 `APP_VERSION` 依次递到 v1.1.8、v1.1.9，
但线上（`sms.5311314.xyz` / `sms.46cbm.top`）自 v1.1.6 起就没有再部署，这三个号属于未发布的中间态。

按用户决定，**本次对外发布的版本号统一为 v1.1.7**，即「v1.1.6 之后的第一个发布版」，
包含：详情弹层图标条（UX-16）、首页卡片底部单行（UX-17）、窄屏工具栏去横滑 + 长按多选 + 验证码右移（UX-18）、
桌面工具栏单行 + 标签去图标 + 九语种收紧（UX-19）。

- `src/worker.js` 的 `APP_VERSION` 与 README 的截图说明同步为 `v1.1.7`，六平台产物重新生成、`--check` 零漂移。
- 上面各节标题里的 v1.1.7 / v1.1.8 / v1.1.9 保留原样，它们是**迭代批次编号**，不是对外版本号。
- 回归：`870 + 13 + 43 + 37 + 36 + 60` 全绿；README 六张截图按 v1.1.7 重拍（页脚显示 v1.1.7）。

---

## 十三、v1.1.7 发布前的定向回归（外部意见 → 实测 → 三处修复）

把本轮成果交给 ChatGPT 复核（原文 `ego/ux08-gpt-20261112-1730/reply-ux19-release.md`），结论是
「方案通过，没有架构性问题」，并给三条收尾建议：① 多选加一次性提示；② 320 隐藏设备名需避免信息丢失感，
建议只在 ≤340px 生效；③ 发布后跑 320/390/410/901/1024/1366 × 9 语种回归。

第 ③ 条直接跑了，结果推翻了两处旧假设：

| 宽度 | 设备名可用宽度 | 结论 |
| --- | --- | --- |
| 320 | 0（排不下） | 必须让位，否则胶囊顶到第二行、卡片 147→195、document 溢出 4px |
| 360 | 27px | 显示成「Pi…」 |
| 375 | 42px | 显示成「Pixel 8…」 |
| 390 | 57px | 刚好放下「Pixel 8 Pro」 |

即**问题不在 ≤340，而在 361–389**；GPT 建议的 340 断点反而会留下更糟的一段。断点改为 389，
让位时 `display:none`，不占位、不补占位文字（这一条与 GPT 的一致）。

矩阵同时暴露两个真缺陷，均已修：

1. **320 德语 / 葡语横向溢出 31px / 10px**（`.msg-top` / `.msg-time`）：`.msg-top` 是 `nowrap`，
   德语 `Benachrichtigung`、葡语 `Notificação` 来源徽章 + 长号码撑破容器。窄屏放开换行，徽章允许省略。
2. **桌面复制按钮高 22px**，低于 WCAG 2.5.8 的 24px 最小点击目标 → 26px（手机端仍是 40px 高）。

另按第 ② 条的「避免信息丢失感」顺带处理长文案语种的标签折行：`≤430px` 时
de/es/fr/pt/ko 标签 11.5px / 内边距 8px，德语再收一档（11px / 6px / gap 4px），
390 与 410 九语种全部一行；320 极端宽度允许折两行（不产生横向滚动，可接受）。

**回归结果**：9 语种 × 6 宽度 = 54 组，横向溢出 0、工具栏换行 0、390 以上标签折行 0、
胶囊始终贴卡片右边缘、复制按钮手机 40px / 桌面 26px。结构测试 `871 + 13 + 43 + 37 + 36 + 60` 全绿，
`gen_app.py --check` 零漂移。

**未采纳**：第 ① 条的一次性提示（长按多选引导）属于新交互，需要新增九语种文案与「已提示过」的本地状态，
留待用户确认后再做，不塞进本次发布。

---

## 十四、UX-20：窄屏一次性「长按可多选」引导（v1.1.7）

**来源**：ChatGPT 复核 v1.1.7 时的第 1 条建议（可发现性）——「首次进入移动端首页时给一次性提示，可关闭，
关闭后不再主动显示；⋯ 菜单里的『多选』必须保留明确文字，不能只用图标」。

**实现**

| 项 | 做法 |
| --- | --- |
| 位置 | 筛选栏与列表之间（`#selhint`），不遮挡内容、不进列表滚动区 |
| 出现条件 | 仅 `max-width: 660px` 且 `localStorage.sms_selhint !== "1"` |
| 文案 | 九语种 `longPressHint`（如 en: Long-press a message to select several, or use the ⋯ menu） |
| 关闭 | 按钮 `gotIt`（知道了 / Got it / 了解 / 확인 / Entendido / Compris / Verstanden / Entendi），点击写 `sms_selhint=1` |
| 自动收起 | 一旦真的进入过多选（长按 / 右键 / ⋯ 菜单任一路径），立即收起并同样记为已读——说明入口已被摸到，再提示是噪声 |
| 可访问性 | `role="note"`；关闭后焦点移到列表容器（`tabindex=-1`），不会掉回 body |
| 桌面 | 不渲染：桌面有可见的「多选」按钮，这条提示是冗余 |
| ⋯ 菜单 | 「多选」保持文字项（GPT 明确要求，代码里本来就是文字，未改） |

**验证**（真实渲染，390×844）

- 首次进入：显示，高 48–70px（语种不同 2–3 行），`docW = 390` 无溢出；九语种文案全部命中、无 key 残留。
- 点「知道了」：`hidden=true`、`sms_selhint=1`、焦点落到 `#list`；刷新后不再出现。
- 清掉标记后右键进多选：提示自动收起并写入标记（`selecting=true`）。
- 1366 桌面：无论标记是否存在都不渲染。
- 回归：`873 + 13 + 43 + 37 + 36 + 60` 全绿；9 语种 × 6 宽度矩阵仍 54/54 通过；`gen_app.py --check` 零漂移。
- README 的 mobile 截图在拍摄前主动隐藏该条（展示稳定态，不把一次性引导当成常驻 UI）。

**踩坑**：给九语种字典插 key 时，用「从块起点向后找 `selectHint:`」定位插入点，结果 9 条全落进了 zh-CN 块
（重复 key 后者覆盖前者，zh-CN 会显示葡语文案）。改为按语种块起始位置直接插入，问题消失。

---

## 十五、UX-21：长按后的补发 click 把选中状态反选回去（v1.1.7 验收发现，已修）

**怎么发现的**：v1.1.7 部署验收用 ego lite（真实 Chromium + 真实 `touchstart`）跑长按链路，
分时采样发现 t=600ms 已是 `1 selected`，抬手 +500ms 变回 `0 selected`，多选态却还在。

**病因**：`touchstart` 的 500ms 长按计时器里用 `suppressClick = true` + `setTimeout(400)` 复位，
靠一个 400ms 时间窗吞掉抬手后浏览器补发的 `click`。移动端触摸→点击最多还有约 300ms 延迟，
慢抬手（>900ms）时窗口已过，补发的 `click` 落在同一张卡上，`toggleSelCard` 把刚选中的那条又切掉。
时间窗方案的缺陷与设备、抬手快慢强相关，桌面浏览器测不出来。

**修复**：按「哪张卡」屏蔽，而不是按时间窗。

| 位置 | 改动 |
| --- | --- |
| `touchstart` | 新手势开始先 `suppressClickId = null`（避免误吞用户这一次真实点击） |
| 长按计时器 | `suppressClickId = card.getAttribute("data-id")`，删掉 400ms 复位定时器 |
| `click` 处理器 | 命中 `data-id` 相同的卡片才吞一次并清标记；命中别的卡片则放行并清标记 |

**复验**（390×844，真实触摸 750ms）：t=600 / t=900 / 抬手 +500ms 三处均 `1 selected`；
补选 2 条 → `3 selected`；`Esc` → 退出且归零。结构断言 `UX-21` 已加入 `tests/run.mjs`（874 项）。

**版本处理**：线上两域名已在跑 v1.1.7，按用户决定**保持同号**，修复随下一次部署生效；
完整验收记录见 `docs/releases/v1.1.7-acceptance.md`。

---

## 十六、详情操作条三次返工：UX-22 → UX-25（v1.1.8）

这一条是「按标注改，但标注要先读懂」的反面教材，记下来避免重犯。

### 16.1 三轮改动的真实原因

| 轮次 | 我做的 | 问题 |
| --- | --- | --- |
| UX-22 | 把「复制验证码」从图标条**移出**，改成正文下方独占一行的实心按钮 | 方向错了。用户的诉求是「它在图标条这个位置不能被裁掉」，不是「它不该在图标条里」 |
| UX-23 | 挪回图标条，7 格改 `flex:1 1 0` 等分，行尾固定；实心主色 | 溢出解决了（7×46=322 装进 321），但用 `flex:2.1` 给码值留宽，导致其余 6 格只有 35px 宽，触控区掉一半 |
| UX-24 | 放弃在格子里印码值，7 格真等分（390 → 46×44、320 → 36×44） | 顺手发现桌面老 bug：`.modal-foot` 是 `nowrap`，而 `.foot-bottom` 是 `flex:0 0 100%`，父级不换行会把 `.foot-rail` 压成 **0 宽**，7 个按钮竖排成一列，1366 下 footer 高达 305px |
| UX-25 | 取消「复制全文」按钮（双击 / 长按正文全选）；复制验证码钉**最右**且**仅含码时渲染**；顺序按「右边最好按」重排 | 定版 |

### 16.2 最终形态

- **图标条（左 → 右）**：标签 · 打电话 · 标为未读 · 收藏 · 置顶 · 复制验证码。
  依据：右撇子右手拇指最先够到右端，最左最难够到 —— 最少用的「标签」放最左，最高频的「复制验证码」放最右。
- **复制验证码**：实心主色（`--ds-color-primary-fill` + `--ds-color-on-primary`），`code ? … : ''` 条件渲染，没码的消息 DOM 里根本没有 `#dccopy`。
- **复制全文按钮已删除**：`selectBodyText()` + `bindBodySelectAll()` 挂在 `.detail-body` 上，
  `dblclick` 与 `touchstart`+500ms 触发 `Range.selectNodeContents`；长按期间位移 > 8px 判为滚动取消；落在正文内 `<a>` 上不接管。
- `.detail-body` 显式 `user-select:text`，避免被卡片层的 `user-select:none` 继承影响。

### 16.3 ego lite 实测（真实 Chromium）

| 宽度 | 格数 | 每格 | 溢出 | 详情底栏高 |
| --- | --- | --- | --- | --- |
| 320 | 6 | 42×44 | 0 | 120px |
| 390 | 6 | 52×44 | 0 | 120px |
| 430 | 6 | 52×44 | 0 | 120px |
| 1366 | 6（带文字标签单行） | — | 0 | 120px（修 nowrap 前为 305px） |

交互实测（390，CDP 真实事件）：双击正文选中 `101/101` 字；`Input.dispatchTouchEvent` 长按 750ms 同样 `101/101`；
无码消息打开后 `#dccopy` 不存在（该条为非短信来源，只剩 未读/收藏/置顶 3 格）。

### 16.4 两个技术坑

1. **`background` 被更高权重规则吃掉**：`.modal-foot .tbtn`（0,2,0）写了 `background: transparent`，
   而 `.tbtn--code` 只有（0,1,0），主色底完全不生效 —— 实测 `getComputedStyle` 拿到 `rgba(0,0,0,0)` 才发现。
   改成 `.tbtn.tbtn--code`（0,2,0）+ 位置在后，才压得住。
2. **只测「计划值」不测「计算值」会漏**：`overflow: 0` 看着正常，实际按钮宽 35px。断言里补上每格宽度与 `withinRail`（右边缘不越界）。

