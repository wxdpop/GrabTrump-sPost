---
name: "grab-trump-post"
description: "监控特朗普 Truth Social 帖子，检测点名美股上市公司时推送飞书告警。调用并输入初始化时配置执行间隔与飞书 Webhook 并创建定时任务。"
---

# Grab Trump's Post - 特朗普 Truth Social 美股监控技能

监控特朗普 Truth Social 帖子，当特朗普在原文中直接点名美股上市公司（含 ADR）时，自动生成分析报告并推送到飞书群（手机接收推送通知）。

## 路径约定（重要）

本技能**所有文件路径均相对于技能根目录**（即 `SKILL.md` 所在目录），**不使用硬编码绝对路径**，以确保跨平台、跨机器、跨 Agent 可移植。

- 执行脚本时，请先 `cd` 到技能根目录，或使用脚本自身的路径
- 脚本内部已使用 `__dirname` 自动定位技能根目录，无需依赖工作目录
- 下文中的路径标记说明：
  - `trump_stock_monitor.js` = 技能根目录下的脚本
  - `config.json` = 技能根目录下的配置文件
  - `report_template.md` = 技能根目录下的报告模板
  - `processed_ids.json` = 技能根目录下的历史记录
  - `temp/` = 技能根目录下的临时文件目录

**Agent 调用时拼接路径的方式**：`{技能根目录}/trump_stock_monitor.js`

## 触发条件

- 用户调用本技能并输入 **"初始化"** → 进入初始化配置流程
- 定时任务自动触发 → 执行日常监控流程
- 用户手动要求"检查特朗普最新帖子" → 执行一次性监控

---

## 一、初始化流程（用户输入"初始化"时执行）

当用户调用本技能并输入"初始化"（或"initialize"、"配置"、"setup"）时，严格按以下步骤执行：

### 步骤 1：询问执行间隔

使用 `AskUserQuestion` 工具询问执行间隔：

```json
{
  "questions": [{
    "header": "执行间隔",
    "multiSelect": false,
    "question": "希望多久执行一次监控任务？",
    "options": [
      {"label": "1 小时", "description": "每小时整点执行（美股开盘时段监控最及时）"},
      {"label": "2 小时", "description": "每 2 小时整点执行（平衡及时性与资源消耗）"},
      {"label": "3 小时", "description": "每 3 小时整点执行（低频监控，节省资源）"}
    ]
  }]
}
```

用户也可通过 "Other" 手动输入其他间隔（如 4、6 小时）。

### 步骤 2：询问飞书 Webhook 地址

使用 `AskUserQuestion` 工具收集飞书推送链接：

```json
{
  "questions": [{
    "header": "飞书 Webhook",
    "multiSelect": false,
    "question": "请提供飞书自定义机器人 Webhook 地址（格式：https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxxxxxxxxxxxx）。可通过 Other 选项粘贴链接。",
    "options": [
      {"label": "使用已有配置", "description": "如果 config.json 已存在且包含 webhookUrl，则沿用现有配置"},
      {"label": "稍后配置", "description": "跳过飞书配置，仅创建定时抓取任务（检测到告警时不会推送飞书）"}
    ]
  }]
}
```

用户通过 "Other" 粘贴完整的 Webhook URL（必须以 `https://open.feishu.cn/open-apis/bot/v2/hook/` 开头）。

### 步骤 3：写入 config.json

将收集到的配置写入技能根目录下的 `config.json`（与 SKILL.md 同级）：

```json
{
  "feishu": {
    "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxxxxxxxxxxxx",
    "keyword": "特朗普",
    "atAll": true
  },
  "schedule": {
    "intervalHours": 1,
    "timezone": "Asia/Shanghai"
  },
  "monitor": {
    "limit": 20
  }
}
```

**写入位置**：技能根目录下的 `config.json`（Agent 应自动定位 SKILL.md 所在目录作为技能根目录）

### 步骤 4：创建定时任务（Trae 环境）

在 Trae 环境中，使用 `Schedule` 工具创建定时任务。根据执行间隔映射 cron 表达式：

| 间隔 | cron 表达式 | 说明 |
|---|---|---|
| 1 小时 | `0 * * * *` | 每小时整点 |
| 2 小时 | `0 */2 * * *` | 每 2 小时整点 |
| 3 小时 | `0 */3 * * *` | 每 3 小时整点 |
| N 小时 | `0 */N * * *` | 每 N 小时整点（N ≤ 12） |

**Schedule 调用参数**：
- `action`: "create"
- `name`: "特朗普 Truth Social 美股监控"
- `cron_expression`: 根据间隔生成
- `timezone`: "Asia/Shanghai"
- `message`: 见下方"定时任务 message 模板"

### 定时任务 message 模板

```
执行特朗普 Truth Social 美股监控任务（技能化版本 v8.3）。

【路径约定】所有路径均相对于技能根目录（SKILL.md 所在目录）。
Agent 在执行以下命令前，应先定位技能根目录的绝对路径（通过查找 SKILL.md 位置），
并将命令中的 {SKILL_DIR} 占位符替换为实际的技能根目录绝对路径。

执行步骤：

1. 运行抓取脚本（静默模式，仅在有新帖子时输出原始内容）：
   node "{SKILL_DIR}/trump_stock_monitor.js" --limit 20
   注意：不加 --verbose，保持静默

2. 解析脚本输出：
   - 如果 stdout 完全为空（无新帖子/已处理过/未点名公司/抓取失败/非监控时段）：不要输出任何文字、任何提示、任何弹窗，直接结束会话
   - 如果 stdout 有内容（包含 "【Trump Truth Social 帖子】" 分隔符）：读取所有帖子内容，进入步骤 3

3. AI 审核判断（严格遵守规则）：
   - 特朗普是否在帖子原文中直接点名了某家美股上市公司？
   - 美股公司定义：在美国证券交易所上市的股票，含 ADR（如 TSM、BABA、JD、TM 等）
   - "直接点名"的定义：特朗普自己的文字中明确提到公司名称（如 General Dynamics、Tesla、TSMC、Boeing、阿里巴巴等）
   - 以下情况不算直接点名：
     * 帖子只是转发一个 URL，没有其他文字
     * 公司名仅出现在被转发的文章中，特朗普原文没有提到
     * 图片附件 URL 中的文字
     * 帖子内容与某个公司有关联但未明确提到公司名
   - 视频帖和纯图片帖已被脚本自动过滤，无需考虑

4. 根据审核结果：
   - 未点名任何公司：不要输出任何文字，直接结束会话
   - 点名了公司：使用 WebFetch 抓取公司基本面数据 + 美股三大指数，按 {SKILL_DIR}/report_template.md 模板输出报告
   - 多公司分多条独立报告输出，每条之间用独占一行的 "---" 分隔

5. 获取基本面数据：
   - 公司基本面：WebFetch Yahoo Finance 页面（每家公司分别抓取）
   - 道琼斯：WebFetch DJI 页面
   - 标普500：WebFetch SPX 页面
   - 纳斯达克：WebFetch IXIC 页面

6. 输出要求：
   - 不输出英文原文，只输出关键句子的中文翻译
   - 只有真正有点名公司时才输出报告
   - 报告直接输出到对话框
   - 多家公司分多条独立报告输出，每条之间用独占一行的 "---" 分隔

7. 【飞书推送】在报告输出完毕后，将完整报告内容写入临时文件并推送：
   a. 使用 Write 工具将完整报告写入技能根目录下的 temp 目录：
      {SKILL_DIR}/temp/feishu_report.txt
      （保留独占一行的 "---" 分隔符和 markdown 格式）
   b. 执行命令发送到飞书（相对路径基于 temp/ 目录自动解析）：
      node "{SKILL_DIR}/trump_stock_monitor.js" --send-feishu "feishu_report.txt"
   c. 脚本会自动：
      - 将 markdown 格式转换为飞书友好的纯文本格式
      - 按 "---" 分隔符拆分成多条独立消息分别发送（每家公司一条）
      - 每条消息标题自动提取公司名
      - 每条消息开头添加 @所有人标签，触发手机推送通知
      - 推送完成后自动清理 temp/ 目录下的临时文件
   d. 如果飞书发送失败，不要报错，继续执行步骤 8

8. 【告警后交互】如果有公司被点名（输出了报告），在飞书推送完成后，必须使用 AskUserQuestion 工具弹出提问选项：
   - questions: [{"header": "下一步操作", "multiSelect": true, "question": "检测到特朗普点名公司告警（已推送到飞书），你希望进一步执行哪些操作？", "options": [{"label": "检索社交平台分析", "description": "检索 X(Twitter)和 Reddit 上关于这只股票的最新分析帖子和讨论"}, {"label": "深挖公司基本面", "description": "深入分析该公司基本面、业务模式、历史股价走势、财务数据，汇总最终分析结果"}, {"label": "两者都做", "description": "同时执行社交平台检索和基本面深挖，输出综合分析报告"}, {"label": "暂不操作", "description": "只查看当前告警报告，不执行进一步操作"}]}]
   根据用户选择执行相应操作

9. 静默执行规则：
   - 未点名任何公司时，绝对不输出任何文字，不弹窗，不发送飞书，直接结束会话
   - 只有有点名公司时才输出报告 + 发送飞书 + AskUserQuestion 弹窗

注意事项：
- 脚本版本：v8.3（技能化版本，含 config.json 外置配置 + temp/ 临时文件管理 + 推送后自动清理）
- 脚本位置：技能根目录下的 trump_stock_monitor.js
- 配置文件：技能根目录下的 config.json（含飞书 Webhook 地址）
- 报告模板：技能根目录下的 report_template.md
- 历史去重：技能根目录下的 processed_ids.json（自动维护）
- 临时文件：技能根目录下的 temp/ 目录（推送完成后自动清理）
- 主备源：trumpstruth.org（主）→ Truth Social API（备）→ WebFetch（兜底）
- 视频帖和纯图片帖已自动过滤
- 北京时间 9:00-17:00 静默跳过（美股未开盘时段）
- 飞书推送：检测到目标内容时自动推送到飞书 Webhook 机器人，手机飞书 app 可接收推送通知
- 模板必须完整且顺序正确：关键句子（中文）→ 利好利空 → 行动建议 → 公司业务 → 基本面 → 机构评级 → 帖子信息 → 美股三大指数宏观分析
- ADR 也算美股公司：TSM、BABA、JD、TM 等
- 静默执行是硬性约束：无警报时不得输出任何文字
- 多公司必须分多条独立报告输出，不能合并
- 报告之间的分隔符必须是独占一行的 "---"（三个连字符），脚本据此拆分成多条飞书消息
```

### 步骤 5：确认初始化完成

告知用户：
- 配置文件已写入技能根目录下的 `config.json`
- 定时任务已创建（含 cron 表达式和下次执行时间）
- 飞书推送地址（脱敏显示）
- 可随时再次输入"初始化"重新配置

---

## 二、日常监控流程（定时任务触发时执行）

严格按照"定时任务 message 模板"中的步骤 1-9 执行。核心要点：

### 脚本调用

```bash
# {SKILL_DIR} 为技能根目录的绝对路径（Agent 自动定位）
node "{SKILL_DIR}/trump_stock_monitor.js" --limit 20
```

### 输出协议（严格遵守）

| 脚本 stdout | AI 行为 |
|---|---|
| 完全为空 | 不输出任何文字、不弹窗、直接结束会话 |
| 有"【Trump Truth Social 帖子】"内容 | 读取帖子，进入 AI 审核 |

### AI 审核规则

- ✅ **直接点名**：特朗普原文中明确提到公司名（如 Tesla、Boeing、TSMC、阿里巴巴）
- ❌ **不算直接点名**：
  - 帖子只是转发 URL，无其他文字
  - 公司名仅出现在被转发文章中
  - 图片附件 URL 中的文字
  - 帖子与某公司相关但未明确提到公司名

### 报告生成

- 按技能根目录下的 `report_template.md` 模板生成 9 部分报告
- 多公司分多条独立报告，每条之间用独占一行的 `---` 分隔
- 数据获取：WebFetch Yahoo Finance + 美股三大指数

### 飞书推送

1. 将完整报告写入技能根目录下的 `temp/feishu_report.txt`
2. 执行：`node "{SKILL_DIR}/trump_stock_monitor.js" --send-feishu "feishu_report.txt"`（相对路径基于 `temp/` 自动解析）
3. 脚本自动转换格式、拆分多条、@所有人推送、清理 temp/

### 告警后交互

推送完成后，使用 `AskUserQuestion` 询问下一步操作（检索社交平台分析 / 深挖基本面 / 两者都做 / 暂不操作）。

---

## 三、跨平台 / 跨 Agent 兼容性说明

本技能的设计与运行**不绑定特定 AI Agent 或平台**，也**不绑定特定机器路径**。核心执行逻辑封装在 `trump_stock_monitor.js`（纯 Node.js 脚本），脚本内部使用 `__dirname` 自动定位技能根目录，任何能调用 Node.js 并按输出协议处理的 AI Agent 均可承载。

### 路径定位规则（关键）

- 脚本内部使用 `__dirname` 自动定位技能根目录，**不依赖工作目录，不依赖绝对路径**
- `config.json`、`processed_ids.json`、`temp/`、`report_template.md` 均通过 `path.join(__dirname, ...)` 定位
- AI Agent 在调用脚本时，只需知道脚本的绝对路径即可（可通过查找 `SKILL.md` 位置定位技能根目录）
- 在文档中用 `{SKILL_DIR}` 占位符表示技能根目录，Agent 执行时替换为实际路径

### 各 Agent 的自动化任务承载方式

| Agent / 平台 | 自动化任务承载方式 |
|---|---|
| **Trae** | 使用内置 `Schedule` 工具创建 cron 定时任务（推荐，原生支持） |
| **Claude Code** | 由 LLM 自动确定：可用系统 cron (Linux/macOS)、Task Scheduler (Windows)、或 Claude Code 的自定义调度钩子 |
| **CodeX** | 由 LLM 自动确定：可用系统 cron、launchd (macOS)、或 CodeX 的定时执行机制 |
| **其他 Agent** | 由 LLM 自动确定最合适的调度方式，只要能定时触发 `node {SKILL_DIR}/trump_stock_monitor.js` 即可 |

### 跨平台兼容性

- **脚本本身**：纯 Node.js，跨平台（Windows/macOS/Linux），只需 Node.js 运行时
- **路径分隔符**：脚本内部使用 `path.join()` 自动处理，跨平台兼容
- **配置文件**：`config.json` 为 JSON 格式，跨平台通用
- **飞书推送**：标准 HTTPS POST 请求，跨平台通用

### 非 Trae 环境的初始化指引

当本技能被非 Trae 的 Agent 调用时，Agent 应：

1. 通过查找 `SKILL.md` 定位技能根目录
2. 读取 `config.example.json` 作为配置模板
3. 询问用户飞书 Webhook URL 和执行间隔
4. 写入 `config.json` 到技能根目录
5. 由 LLM 自动选择合适的定时调度方式（cron / Task Scheduler / launchd 等）
6. 定时任务的执行内容参照"定时任务 message 模板"

---

## 四、目录结构

```
GrabTrump'sPost/              # 技能根目录（SKILL.md 所在目录）
├── SKILL.md                  # 本文件（技能描述与执行指引）
├── trump_stock_monitor.js    # 主脚本 v8.3（技能化版本，用 __dirname 自定位）
├── config.json               # 飞书 Webhook 配置（初始化时生成，.gitignore 忽略）
├── config.example.json       # 配置文件示例（供参考）
├── report_template.md        # 飞书推送报告模板（9 部分模板）
├── processed_ids.json        # 已处理帖子 ID（运行时自动维护，.gitignore 忽略）
├── .gitignore                # 忽略运行时文件
└── temp/                     # 临时文件目录（feishu_report.txt 等，推送后自动清理）
    └── .gitkeep
```

### 各文件职责

| 文件 | 职责 | 是否提交 Git |
|---|---|---|
| `SKILL.md` | 技能入口，描述初始化与日常执行流程 | ✅ 是 |
| `trump_stock_monitor.js` | 主脚本，抓取/过滤/推送（用 `__dirname` 自定位） | ✅ 是 |
| `config.example.json` | 配置示例 | ✅ 是 |
| `report_template.md` | 报告模板 | ✅ 是 |
| `.gitignore` | Git 忽略规则 | ✅ 是 |
| `temp/.gitkeep` | 保留 temp 目录 | ✅ 是 |
| `config.json` | 实际配置（含 Webhook 密钥） | ❌ 否 |
| `processed_ids.json` | 运行时历史记录 | ❌ 否 |
| `temp/*` | 临时文件 | ❌ 否 |

---

## 五、脚本命令参考

```bash
# 静默抓取最新帖子（默认，定时任务使用）
node trump_stock_monitor.js --limit 20

# 显示进度信息（调试用）
node trump_stock_monitor.js --verbose --limit 20

# 演示模式（强制输出 + 发送飞书测试消息）
node trump_stock_monitor.js --demo

# 清空历史记录（重置已处理帖子 ID）
node trump_stock_monitor.js --reset

# 发送飞书消息（从 temp/ 读取文件，相对路径基于技能根目录自动解析）
node trump_stock_monitor.js --send-feishu "feishu_report.txt"

# 发送飞书消息（绝对路径，跨目录文件）
node trump_stock_monitor.js --send-feishu "/path/to/report.txt"
```

> 注：以上命令在技能根目录下执行；若在其他目录执行，需用脚本绝对路径调用，脚本内部会自动通过 `__dirname` 定位 `config.json`、`processed_ids.json`、`temp/` 等文件。

---

## 六、关键约束

1. **静默执行是硬性约束**：无警报时不得输出任何文字、不弹窗、不发送飞书
2. **"直接点名"判定严格**：必须是特朗普原文中明确提到公司名，转发/图片/关联不算
3. **多公司分多条报告**：不能合并，每条之间用独占一行的 `---` 分隔
4. **模板顺序固定**：9 部分顺序不可调整
5. **ADR 也算美股**：TSM、BABA、JD、TM 等
6. **北京时间 9:00-17:00 静默跳过**：美股未开盘时段无需监控
7. **推送后自动清理 temp/**：保留 .gitkeep，删除其他文件
8. **飞书发送失败不阻断流程**：继续执行告警后交互
9. **路径不硬编码**：所有文件路径均相对于技能根目录，脚本用 `__dirname` 自定位

---

## 七、故障排查

| 问题 | 解决方案 |
|---|---|
| 脚本无输出 | 正常（无新帖子/非监控时段/未点名公司） |
| `config.json` 不存在 | 输入"初始化"重新配置，或手动复制 `config.example.json` |
| 飞书发送失败 | 检查 `config.json` 中 webhookUrl 是否正确、关键词是否匹配 |
| 历史记录异常 | 执行 `node trump_stock_monitor.js --reset` 清空重来 |
| 抓取失败 | 脚本会自动主备切换，AI 可用 WebFetch 兜底访问 trumpstruth.org |
| 临时文件堆积 | 正常情况推送后自动清理；如残留可手动删除 `temp/` 下文件（保留 .gitkeep） |
