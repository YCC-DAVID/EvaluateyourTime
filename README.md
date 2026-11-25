# 时间记录（暂名）

个人时间利用记录工具：轻量记录 → AI 整理与最多 3 个问题 → 确认事实 → 可解释、可修改的评分 → 每日热力图与统计。

> 工作认真工作，娱乐尽兴娱乐，休息安心休息。

当前进度：P1（本地记录闭环）+ P2（AI 评分闭环）的桌面网页版。

## 运行

需要 Node.js 22.5 或更高版本（使用内置的 `node:sqlite`）。

```bash
npm install
cp .env.example .env   # 选择 AI 后端，见下文
npm run dev            # 打开 http://127.0.0.1:5180
```

AI 后端三选一（`.env` 中的 `AI_PROVIDER`）：

| 后端 | 需要 | 费用 |
|---|---|---|
| `claude-cli` | 本机装好并登录 Claude Code（`claude`） | 占用你的 Claude 订阅额度 |
| `codex-cli` | 本机装好并登录 Codex（`codex login`） | 占用你的 ChatGPT 订阅额度 |
| `api` | `ANTHROPIC_API_KEY` | 按 API 用量计费 |

不设置时：填了 API key 就用 `api`，否则用 `claude-cli`。CLI 后端只在本机运行，App 不读取、不保存 CLI 的登录凭据；每次调用都关闭全部工具（Claude Code 用 `--tools ""`，Codex 用只读沙箱），在新建的空临时目录中运行，用完删除。

完全不用 AI 也能用：记录、手动分配时间、手动评分、热力图和统计都可以离线完成。

## 一条记录的流程

1. 选择时间段（默认从上次记录结束到现在），用文字或语音描述做了什么。
2. **保存并分析**：原始记录先存进本地，再请 AI 整理活动标题、候选时间分配（标为“估计”）和 0–3 个事实问题。
3. 调整分钟数或百分比（两者自动换算），回答问题，选择关联目标。说不清的时间留作“未分配”，不判低分。
4. **确认事实并让 AI 评分**：AI 给出执行质量、目标贡献、安排合理性三个维度和理由；**整体分由程序按版本化规则计算**（`modules/scoring` 的 `RULES_V1`）。
5. 不同意可以拖动修改，并选择修改原因。原始 AI 分、修改后的分和原因都保存在评分历史里。

AI 调用失败不会丢记录：状态变为“分析失败”，可以重试或手动填写。分析期间如果你改了记录，旧结果会被丢弃，不覆盖新的输入。

## 目录

```text
apps/desktop/
  src/            网页界面（React）
  server/         本地服务：API、SQLite、导入导出、语音转写转发
modules/
  scoring/        时间、分配、评分、热力图、统计的纯函数（含测试）
  ai/             提示词、结构化输出契约、AI 后端（API / Claude Code / Codex）
data/             本地数据库（不进 git）
```

## 配置（.env）

| 变量 | 说明 |
|---|---|
| `AI_PROVIDER` | `api` / `claude-cli` / `codex-cli` |
| `ANTHROPIC_API_KEY` | Claude API key，只保存在本机；CLI 后端不会把它传给子进程 |
| `AI_MODEL` | API 后端的模型，默认 `claude-opus-5-5` |
| `CLAUDE_CLI_MODEL` / `CODEX_MODEL` | 可选，CLI 后端的模型；留空用 CLI 默认 |
| `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH` | 可选，命令不在 PATH 里时填完整路径 |
| `AI_BASE_URL` | 可选，自定义 API 地址；留空为官方地址 |
| `AI_FALLBACKS` | 默认开启服务端备用模型（模型拒答时自动换备用模型）；设为 `off` 关闭 |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | 可选，OpenAI 兼容的语音转写接口；不填时用浏览器自带语音识别 |

## 隐私

- 数据默认只在本机 `data/app.db`；服务只监听 `127.0.0.1`。
- 发给 AI 的内容：当前这段记录的文字、时段、分类列表、进行中的目标，以及当天更早记录的标题。
- 设置页可导出完整 JSON 备份，并可从备份导入（按 ID 合并，不会用旧版本覆盖新版本）。

## 测试

```bash
npm test          # 时间、分配、评分、热力图的边界用例
npm run typecheck
```
