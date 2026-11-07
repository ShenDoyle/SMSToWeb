# Design System（v1）

本项目的 UI 设计体系。**唯一令牌源**在 `src/worker.js` 顶部的 `DS_TOKENS_CSS` 常量，管理页与登录页都通过
`${DS_TOKENS_CSS}` 注入同一字符串；改一处，两页同时生效，且经 `python platforms/gen_app.py` 同步到六个平台。

> 不改版本号、不引入 CSS 框架/UI 库/外部字体；全部为原生 CSS 变量 + 类名，无额外运行时依赖。

## 1. 令牌（`--ds-*`）

| 类别 | 令牌 | 用途 |
|---|---|---|
| 颜色 · 背景 | `--ds-color-bg-page` / `--ds-color-bg-surface` / `--ds-color-bg-subtle` | 页面底 / 卡片面 / 次级面（统计块等） |
| 颜色 · 文本 | `--ds-color-text` / `-secondary` / `-tertiary` | 正文 / 次级 / 辅助 |
| 颜色 · 主色 | `--ds-color-primary` / `-hover` / `-subtle` | 主操作 / 悬停 / 浅底 |
| 颜色 · 状态 | `--ds-color-success` / `-warning` / `-danger` / `-info` / `-unread` / `-disabled` | 语义状态，禁止页面内写死色值 |
| 颜色 · 结构 | `--ds-color-border` / `-border-subtle` / `-divider` / `-link` | 边框 / 卡片边 / 分割 / 链接 |
| 字体 | `--ds-font-family` / `--ds-font-mono` | 正文族 / 验证码等等宽 |
| 字号 | `--ds-text-xs…2xl`（12/13/14/16/18/20） | 辅助 → 页面标题 |
| 字重/行高 | `--ds-weight-normal/medium/bold`、`--ds-leading(-tight)` | 中文可读性优先 |
| 间距 | `--ds-space-1…7`（4/6/8/12/16/24/32） | 统一页面/区块/字段间距 |
| 尺寸 | `--ds-content-max`、`--ds-control-h(-sm)`、`--ds-radius-sm…pill`、`--ds-border-w` | 内容宽度 / 控件高度 / 圆角 |
| 阴影 | `--ds-shadow-1/2/3` | 卡片 / 弹层 / 下拉 |
| 焦点 | `--ds-focus-ring` | 键盘焦点环 |

深色主题只覆盖令牌值（`prefers-color-scheme` 与 `data-theme="dark"`），**不重定义**各组件样式。

## 2. 兼容别名

历史变量保留为令牌别名，旧选择器零改动即继承新体系：

```css
--bg: var(--ds-color-bg-page);  --card: var(--ds-color-bg-surface);
--text: var(--ds-color-text);   --muted: var(--ds-color-text-secondary);
--accent: var(--ds-color-primary);  --border: var(--ds-color-border);
```

迁移期保留；后续清理需先全量检索引用。

## 3. 组件（`.ds-*`）

| 组件 | 类名 | 说明 |
|---|---|---|
| 按钮 | `.ds-btn`、`--primary`、`--danger`、`--block` | 次/主/危险/通栏；`data-loading="1"` 自带旋转指示 |
| 输入 / 下拉 | `.ds-input`、`.ds-select` | 非法时 `aria-invalid="true"` 变红边 |
| 表单 | `.ds-field`、`.ds-help`、`.ds-error-text` | 标签 / 说明 / 错误 |
| 开关 | `.ds-switch`（配 `input:checked`） | 与旧 `.switch` 同视觉 |
| 复选 / 单选 | `.ds-check`、`.ds-radio`、`.ds-inline` | 行内排布 |
| 卡片 / 分组标题 | `.ds-card`、`.ds-group-title` | |
| 状态标签 | `.ds-badge`、`--success/warning/danger/info` | 图标或文字优先，不只靠颜色 |
| 作用域徽章 | `.ds-scope`、`--global`、`--browser` | 设置项作用域：全局 / 本浏览器 |
| 提示 | `.ds-alert`、`--warning`、`--danger` | 左侧色条 + 文本 |
| 空状态 | `.ds-empty` | |
| 弹层 | `.ds-modal`、`.ds-sheet`、`.ds-dialog-actions` | 窄屏沿用既有底部抽屉规则 |

旧类名（`.tbtn`、`.card`、`.modal/.sheet`、`.opt/.switch`、`.setgrp/.setrow`）继续有效，视觉与 `.ds-*` 同源。

### 3.1 消息列表专用（v1.0.4 第二阶段）

| 元素 | 类名/结构 | 规则 |
|---|---|---|
| 摘要卡片 | `.content.summary` | 只显示约 20 个码位（服务端按 Unicode 截取）；点击或点「查看详情」打开完整正文 |
| 详情按钮 | `.more`（`data-id`） | 复用 `.tbtn` 视觉，文案走 `detailBtn` |
| 加载更多 | `.morewrap > #loadmore`、`#nomore` | 居中的 `.tbtn`；加载中 `data-loading="1"`；到底显示 `.nomore` |
| 未读入口 | `#unreadbtn.unreadpill` | 数量 + 「未读」文字（不只靠颜色）；选中态 `data-on="1"` 用主色浅底 |
| 未读标记 | `.undot` | 6px 圆点 + `title` 文本，配合详情/筛选 |
| 验证码 | `.code-line b` / `.copy` | 等宽字体 + 强调色块，复制按钮保留 |

## 4. 交互状态

所有按钮/输入/链接统一 `:focus-visible` 焦点环（2px `--ds-color-link`，offset 2px）；
禁用态 `:disabled` 降透明 + `not-allowed`；加载态 `data-loading="1"`；
`prefers-reduced-motion` 下动画与过渡关闭（沿用既有规则）。

## 5. 页面接入

| 页面 | 令牌 | 组件层 | 证据 |
|---|---|---|---|
| 登录页 | ✅ 共用 `DS_TOKENS_CSS` | 精简（仅表单所需） | `string.raw` 注入，测试断言 `--ds-color-primary` 存在 |
| 管理后台 | ✅ | ✅ `DS COMPONENTS v1` | 同上 |
| 验证码 | ✅ | `.code-line b` / `.copy` 语义化 | 等宽字体 + 强调色块 + 焦点环 |
| 设备管理 | ✅ | 沿用 `.tabs` / `.tbtn` | 令牌继承 |
| 设置中心 | ✅ | ✅ `ds-tabs` / `ds-btn` / `ds-scope` / `ds-alert` | 见 `docs/SETTINGS.md` |
| 消息列表 | ✅ | ✅ `.content.summary` / `.morewrap` / `.unreadpill` / `.undot` | 摘要卡片 + 详情弹层，复用 `.ds-btn`/`.ds-badge` |

## 6. 维护约定

1. 新增颜色先在 `DS_TOKENS_CSS` 定义语义令牌，页面内不得写死色值。
2. 新增组件优先复用 `.ds-*`，避免每页复制一套样式。
3. 改样式后必须重跑 `python platforms/gen_app.py`，再跑 `node tests/run.mjs`。
4. 不使用 `!important` 压制冲突；冲突应在令牌或组件层解决。
