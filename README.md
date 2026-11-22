# dsh-trigger-prompts

给 [DeepSeek Harness](https://github.com/deepseek-ai) 装一个「触发词」按钮：**把每个插件注册给 Agent 的工具描述汇总起来，随时查看、一键复制。**

入口就在聊天顶部的「对话 / 轨迹 / 画廊」右侧 —— 一个叫 **触发词** 的小按钮，点开是下拉面板。

> 为什么要它：插件是靠「工具名 + 工具描述」被模型自动识别的，描述写得好不好直接决定它有没有被调用。以前这些描述散落在几十个 `lib/index.js` 里，装完插件根本看不到自己「到底授权了什么能力、什么场景会触发」。这个插件把那层黑盒直接摊开。

## 功能

| 功能 | 说明 |
| --- | --- |
| 按插件分组 | 每个已装 bundle 一组，显示包名 + 版本 + 中文名 + 工具数量 |
| MCP 单独一组 | `mcp__*` 工具单独归入「MCP 外部工具」，不与内置工具混在一起 |
| 大组自动折叠 | 内置 / MCP 这类大组默认折叠（20 条以上），点分组标题展开 |
| 中文注释 | 顶部中文摘要 + 可展开的英文原文（原文才是模型真正看到的描述） |
| 中 / EN 切换 | 面板右上角「中」按钮，切换只显示中文注释或只显示英文原文，选择记在 localStorage |
| 完整描述 | 每条可展开原文全文，复制按钮复制的是**英文原文**（不是译文） |
| 一键复制 | 每条右侧「复制」按钮，复制该工具的完整描述 |
| 搜索 | 顶部输入框按插件名 / 工具名 / 描述关键字过滤，搜索时自动展开所有分组 |
| 置顶 | 面板右上角 📌，置顶后与页面其它区域交互（点聊天、切视图、滚轮）都不会自动关闭；状态记在 localStorage |
| 刷新 | ↻ 重新拉取注册表（宿主侧有 8 秒缓存，归属扫描 60 秒缓存） |

关闭方式：再点一次按钮、点面板外空白处（未置顶时）、按 `Esc`、点面板右上角 ✕。

## 安装

```bash
# 本地目录安装（开发）
dsh plugin --profile desktop add "link:D:/dsh-plugins/dsh-trigger-prompts"

# 或从 npm 装（发布之后）
dsh plugin --profile desktop add dsh-trigger-prompts
```

装完 **退出并重新打开 DSH**。宿主侧插件要重启才挂载，客户端按钮随页面一起加载。

验证宿主侧是否生效：

```
GET http://127.0.0.1:19387/plugins/dsh-trigger-prompts/list
GET http://127.0.0.1:19387/plugins/dsh-trigger-prompts/zh-cn.json
```

返回形如：

```json
{
  "ok": true,
  "profile": "desktop",
  "tools": [
    { "name": "doubao_paint", "description": "把生图/P图任务交给本机的「豆包」…", "plugin": "dsh-doubao-painter" },
    { "name": "generate_image", "description": "Generate a new image…", "plugin": "dsh-image-gen" }
  ],
  "plugins": [{ "id": "dsh-image-gen", "version": "0.10.2", "count": 3 }]
}
```

## 工作原理

**宿主侧**（`lib/index.js`）

1. `ctx.tools.schemas()` —— DSH 工具注册表对外的只读视图，返回每个工具 `name / description / parameters`。这就是模型每轮推理时看到的那份内容，未做任何加工。
2. 归属推测：读各 profile 的 `dsh.profile.bundles`，对每个 bundle 的 `lib/**.js` 做**字符串匹配**（找 `"工具名"`），命中即认为该插件注册了它。不执行插件代码、不调用工具；多个 profile 共用 pnpm store 时同一物理包只读一次。
3. 结果挂到两个只读接口：`/list`（工具清单，8 秒内存缓存）与 `/zh-cn.json`（中文注释表，读 `data/zh-cn.json`）。

**客户端**（`client.js`）

1. 宿主没有给「页签行尾部」留插槽 —— `conversation.view` 注册的是真正的视图页签，点下去会切换主区域。所以这里用 DOM 观察找到 `[data-conversation-tabs]`，把按钮**追加为页签行的最后一个子元素**，位置正好在「画廊」右边。
2. `MutationObserver` + 2 秒兜底定时器保证 React 重渲染、切换会话后按钮仍在。
3. 面板挂到 `document.body`，用 `position: fixed` 跟随按钮定位；配色走 CSS 系统色（`Canvas` / `CanvasText`），深浅色主题都跟得上。
4. 不依赖 React、不需要构建：客户端入口就是一段可直接加载的 IIFE。

## 中文注释表

插件注册的工具描述大多是英文（那是给模型看的原文），所以面板默认在上面叠一行**中文注释**，原文收在「原文 ▸」后面：

- 数据在 `data/zh-cn.json`，结构是 `{ plugins: { 包名: 中文名 }, tools: { 工具名: 中文说明 } }`；
- 只是展示层，**不改变**模型看到的描述，也不影响工具是否被调用；复制按钮复制的是英文原文；
- 没收录的条目（例如 229 个 `mcp__rea__*` 外部 MCP 工具）会直接显示英文原文，不会显示空白；
- 想补条目：编辑 `data/zh-cn.json` 后重启 DSH 即可，不需要改代码；欢迎 PR。

附带修的一个坑：归属扫描会跳过 `data/`、`docs/`、`tests/` 目录，否则中文注释表里出现的工具名会让插件把这些工具误算成自己注册的。

## 已知限制

- **归属是推测的**：靠源码里是否出现工具名字符串判断。工具名若出现在两个包里会归给先扫到的那个；压缩/拼接严重的包里可能漏判，此时该工具落到「内置 / 其它」。
- **中文注释是人工维护的**：只有 `data/zh-cn.json` 里收录的工具才有中文摘要；新装插件需要补条目（或直接切到 EN 看原文）。
- **按钮是 DOM 注入**而不是官方插槽：DSH 大版本改页签结构时可能需要跟着改选择器（当前按 `[data-conversation-tabs]` 定位）。按钮不在页签的 `role="tab"` 序列里，键盘 Tab 导航不包含它（鼠标/触控正常）。
- **只读**：不修改任何工具描述，也不改变工具是否被调用；要看完整 JSON（含 parameters）请直接请求接口。
- 描述里的参数 schema 不展示，只展示 `description` 文本与中文注释。

## 开发

```bash
node tests/smoke.mjs   # 假 ctx 跑通：注册路由 → 归属 → HTTP 响应
```

无第三方依赖，`node >= 20`。

## License

MIT © stook-404
