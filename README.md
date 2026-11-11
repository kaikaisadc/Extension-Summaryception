# 🧠 Summaryception（简体中文分支）

> **非官方简体中文 fork。** 上游项目：[Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception)，作者 **Lodactio**，许可证 **AGPL-3.0**。

本分支只翻译用户界面和文档；摘要模型提示词、注入模板、存储结构、命令名和核心逻辑均保持上游原样。原版英文 README 完整保留在 [README.en.md](README.en.md)。

---

## 这是什么

Summaryception 是一个面向 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的分层递归摘要记忆扩展。它保留最近一段助手轮次的原文，把更早的对话压缩成摘要片段；当某一层的片段积累过多时，再把旧片段递归合并到更深一层。生成回复时，已摘要的旧消息会从模型上下文中排除，但你仍然可以在聊天界面里向上滚动阅读原文。

该扩展使用 SillyTavern 原生的 `/hide` 和 `/unhide` 命令来隐藏消息，不会删除聊天记录，属于非破坏性处理。

**关于效果的说明：** 摘要本身是**有损压缩**，片段会省略细节；能记住多少、摘要是否准确，取决于所用模型、提示词、语言和聊天内容。本项目不承诺“无损记忆”，也没有对具体模型或硬件做过性能基准测试。文档中的分层和 token 说明只是机制描述，不是实测保证。

---

## 主要功能

- **分层递归摘要**：第 0 层直接摘要对话轮次；更深的层把旧片段再次摘要，形成多层记忆。
- **原文保留窗口**：最近若干个助手轮次按原文发送，更早的轮次才进入摘要。
- **非破坏性消息隐藏**：已摘要消息通过 `/hide` 从模型上下文排除，聊天记录仍然保留。
- **摘要片段浏览器**：查看、编辑、重新生成或删除各层片段。
- **注入预览**：查看当前会注入到模型上下文中的摘要内容。
- **记忆导入/导出**：把当前聊天的摘要记忆导出为 JSON，或从 JSON 恢复。
- **积压处理**：打开旧聊天时检测大量未摘要轮次，可选择全部处理、跳过或只处理一批。
- **强制摘要 / 停止 / 修复孤立消息**：手动补摘要、随时中止并保留进度、修复异常隐藏的消息。
- **多种摘要连接**：默认主 API、OpenAI 兼容端点、本地 Ollama、SillyTavern 连接配置。
- **斜杠命令**：`/sc-status`、`/sc-preview`、`/sc-clear`。

---

## 安装

### 要求

- **SillyTavern 1.16.0+**（release 或 staging）。更旧的版本可能使用不兼容的 `generateRaw` 签名。

### 通过 SillyTavern 界面安装

1. 打开 **Extensions（扩展）** → **Install Extension（安装扩展）**。
2. 粘贴本 fork 地址：
   `https://github.com/kaikaisadc/Extension-Summaryception`
3. 点击安装。
4. 刷新 SillyTavern，在扩展设置中找到 **Summaryception**。

### 手动安装

```bash
cd SillyTavern/data/default-user/extensions/third-party/
git clone https://github.com/kaikaisadc/Extension-Summaryception
```

重启 SillyTavern，然后在扩展设置中启用。

---

## 从原版或其他分支切换

Summaryception 的多个分支使用**相同的内部模块名** `summaryception`，因此：

- **不要同时启用本 fork 和原版（或其他 Summaryception 分支）**，否则设置、摘要记忆和消息隐藏状态可能互相干扰。
- 切换前先**导出当前聊天的记忆**（设置面板中的“导出记忆”），并导出/备份聊天文件和 SillyTavern 设置。
- 切换到本 fork 后，如需要，再用“导入记忆”恢复摘要；导入前建议先确认当前聊天与导出时是同一份。
- 如果你的原版里已有重要摘要，先保留原目录或导出的 JSON，确认新版本工作正常后再清理。

---

## 使用

1. 在扩展设置中勾选 **启用 Summaryception**。
2. 选择摘要使用的连接（见下一节），再按需要调整“原文保留轮次”“每批摘要轮次数”“每层最大片段数”等参数。
3. 正常聊天。超过原文保留窗口的旧助手轮次会被摘要，并从模型上下文中隐藏。
4. 可在“摘要片段浏览器”中检查、编辑或重新生成片段；在“注入预览”中确认实际会发送的内容。
5. 如果积压很多，扩展会弹出补摘要对话框；处理过程中可以随时停止，进度会保存。

### 设置项简述

| 设置 | 作用 |
|---|---|
| 启用 Summaryception | 总开关 |
| 暂停摘要 | 停止处理新轮次，但继续注入已有摘要 |
| 禁用消息隐藏 | 仍然摘要并从模型上下文排除，但不在界面上隐藏消息 |
| 保留的原文助手轮次 | 最近多少条助手消息按原文发送 |
| 每批摘要轮次数 | 每次触发时把多少条最旧轮次合并摘要 |
| 每层最大片段数 | 某层超过该数量后开始向更深层提升 |
| 每次提升的片段数 | 每次提升时合并多少个旧片段 |
| 最大层数 | 允许的递归层数上限 |
| 摘要提示词 | 系统提示词、用户提示词、注入包装模板；预设可选叙事状态/游戏状态/自定义 |
| 清理模式 | 从摘要输出中移除的标签或前缀，每行一个 |
| 调试/跟踪模式 | 输出更详细的控制台日志，供排查问题 |

具体默认值以设置面板显示为准。

---

## 连接设置

摘要请求可以与主聊天使用不同的连接：

| 来源 | 说明 |
|---|---|
| **默认（主 API）** | 使用 SillyTavern 当前连接，配置最简单 |
| **OpenAI 兼容** | 直接填写端点 URL、API 密钥和模型名；支持流式响应 |
| **Ollama（本地）** | 连接本地 Ollama，可刷新模型列表 |
| **连接配置** | 使用 SillyTavern 已保存的连接配置；可能继承预设格式，进而影响摘要质量 |

注意事项：

- 本地 Ollama 或本地 OpenAI 兼容端点通常需要在 SillyTavern 的 `config.yaml` 中设置 `enableCorsProxy: true`，或在 Ollama 侧设置 `OLLAMA_ORIGINS=*`。
- 云 API（例如 OpenRouter）一般不需要 CORS 代理。
- API 密钥会随扩展设置保存在 SillyTavern 的数据目录中，请自行保护好该目录。
- 如果遇到 `max_tokens > 4096 must have stream=true` 一类错误，可在“摘要响应长度”中调整上限；推理模型还需要为思考过程留出足够 token。

---

## 提示词与翻译范围

本分支**有意不翻译**以下内容，以保持与上游一致的行为：

- `summarizerSystemPrompt`（摘要系统提示词）
- `summarizerUserPrompt` 及 `narrative` / `gamestate` 预设（摘要用户提示词）
- `injectionTemplate`（注入包装模板）
- 连接测试使用的内部测试提示词
- 插值变量 `{{player_name}}`、`{{context_str}}`、`{{story_txt}}`、`{{summary}}`

设置面板中的提示词编辑框仍可编辑；如果你自行改成中文或别的写法，那属于自定义修改，效果由你自行承担。

---

## 数据与兼容性

- 每个聊天的摘要保存在聊天元数据中，消息上会带有 `sc_ghosted` 标记；不要手动编辑这些字段。
- 本扩展通过 SillyTavern 的 `/hide`、`/unhide` 命令工作；其他也会修改消息可见性的扩展可能产生交互影响。
- 与其他使用 `summaryception` 模块名的分支**不能同时启用**。
- 本分支未对具体模型、API 提供商或长聊天做性能基准测试；请以实际使用效果为准。

---

## 许可证与版权

- 上游作者：**Lodactio**
- 上游仓库：<https://github.com/Lodactio/Extension-Summaryception>
- 许可证：**AGPL-3.0**，完整文本见 [LICENSE](LICENSE)（未修改）。
- 本简体中文 fork：<https://github.com/kaikaisadc/Extension-Summaryception>

本分支是非官方翻译，与上游作者无隶属关系。原项目版权归原作者所有；本分支的修改同样按 AGPL-3.0 发布。
