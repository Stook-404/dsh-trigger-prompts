# dsh-trigger-prompts

给 [DeepSeek Harness](https://github.com/deepseek-ai) 装一个「触发词」按钮：**把每个插件注册给 Agent 的工具整理成中文清单——这插件是干嘛的、每个工具做什么、说什么话会触发它。**

入口就在聊天顶部的「对话 / 轨迹 / 画廊」右侧 —— 一个叫 **触发词** 的小按钮，点开是下拉面板。

> 为什么要它：插件是靠「工具名 + 工具描述」被模型自动识别的，而用户装完插件常常忘了自己授权了什么能力、该说什么话才会调用。这个插件把那层黑盒摊成一张中文说明书。
>
> 面板只展示中文说明，**不显示也不改变**模型真正看到的英文原文，更不影响工具是否被调用。

## 功能

| 功能 | 说明 |
| --- | --- |
| 按插件分组 | 每个已装 bundle 一组，显示包名 + 版本 + 中文名 + 工具数量 |
| 插件 3 行简介 | 分组标题下一段简介：这插件能干什么、说什么话能触发（超出 3 行裁剪，悬停看全文） |
| 工具一句话用途 | 每条工具给一句中文说明，替代冗长的英文描述 |
| MCP 单独一组 | `mcp__*` 工具单独归入「MCP 外部工具」，不与内置工具混在一起 |
| 大组自动折叠 | 内置 / MCP 这类大组默认折叠（20 条以上），点分组标题展开 |
| 拖拽抓手 | 面板标题左侧 ⠿，长按约 0.25 秒后可拖动整个面板，双击复位；位置记在 localStorage |
| 搜索 | 顶部输入框按插件名 / 工具名 / 中文说明过滤，搜索时自动展开所有分组 |
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

## 中文说明表

插件注册的工具描述大多是英文（那是给模型看的原文），而很多用户装完插件就忘了「该说什么话」才会触发它。所以面板完全用中文呈现：

- 数据在 `data/zh-cn.json`，结构：
  - `plugins[包名] = { name, intro }`：`name` 是中文名，`intro` 是一段简介（这插件干什么 + 示例口令，面板按 3 行裁剪显示）；
  - `tools[工具名] = "一句话用途"`：逐条中文说明；没收录的工具只显示工具名，不会显示英文；
- 只是展示层，**不改变**模型看到的描述，也不影响工具是否被调用；
- 想补条目：编辑 `data/zh-cn.json` 后重启 DSH 即可，不需要改代码；欢迎 PR。

附带修的一个坑：归属扫描会跳过 `data/`、`docs/`、`tests/` 目录，否则中文说明表里出现的工具名会让插件把这些工具误算成自己注册的。

## 拖拽

面板标题左侧有个 ⠿ 抓手：

- **长按约 0.25 秒**后抓起（鼠标会变成 grabbing），拖动即可把面板挪到任意位置；
- 长按过程中若明显移动（>8px）视为误触，不会进入拖拽；
- 双击抓手复位到「触发词」按钮下方；
- 位置记在 localStorage，重开 DSH 仍在原处；窗口变小时会自动夹回视口内。

## 已知限制

- **归属是推测的**：靠源码里是否出现工具名字符串判断。工具名若出现在两个包里会归给先扫到的那个；压缩/拼接严重的包里可能漏判，此时该工具落到「内置 / 其它」。
- **中文说明是人工维护的**：只有 `data/zh-cn.json` 里收录的工具才有说明；没收录的工具只显示名字。新装插件建议补一条（欢迎 PR）。
- **按钮是 DOM 注入**而不是官方插槽：DSH 大版本改页签结构时可能需要跟着改选择器（当前按 `[data-conversation-tabs]` 定位）。按钮不在页签的 `role="tab"` 序列里，键盘 Tab 导航不包含它（鼠标/触控正常）。
- **只读**：不修改任何工具描述，也不改变工具是否被调用；要看完整 JSON（含英文 description 与 parameters）请直接请求 `/list` 接口。
- 面板不渲染英文原文，也不渲染参数 schema。

## 开发

```bash
node tests/smoke.mjs   # 假 ctx 跑通：注册路由 → 归属 → HTTP 响应
```

无第三方依赖，`node >= 20`。

## License

MIT © stook-404
