# Web 工具（webfetch / websearch）实现与真实验证记录

日期：2026-08-19
状态：已通过单元测试与一次完整真实 run 验证

## 1. 背景与目的

run `d122954c-c894-4240-af9d-6f281a30689f` 因 `RUN_LIMIT_EXCEEDED` 失败：模型把 12+8 步全部耗在研究阶段（curl 抓 Bing/Sogou/微信、跟随重定向死循环、解析 3.2MB HTML、手写 Python 解析脚本），`design_poster` 步骤从未启动。

目标：为 AgentLoop 提供符合项目工具规范（PI Agent / OpenCode 风格）的 `webfetch` + `websearch` 工具，用“干净、低噪音、即用的结果”替代手写 curl 研究，节省 LLM token。应用部署在中国大陆，搜索端点必须考虑中国可访问性。

## 2. 工具设计概要

实现文件：`src/web/web-tools.ts`，由 `createWebTools(options)` 返回 `[webfetch, websearch]`，通过 `RunService({ tools })` → pluginTools 注册（`src/app.ts`）。

### 2.1 webfetch

- 原生 Node fetch，跟随 HTTP 与 JS/meta-refresh 重定向（最多 5 跳，跳过 baidu 等公共跳转页）。
- HTML → markdown/text 提取，剥离噪音：`script/style/noscript/template/iframe/svg/head/header/nav/footer/aside/form/figure/figcaption/caption/datalist/optgroup/option`。
- SSRF 防护：默认拒绝 loopback/私网/link-local 目标，`allowPrivateTargets: true` 可放开。
- 默认超时 30s、5MB 读取上限、`maxResultCharacters` 默认 120k。

### 2.2 websearch

- 后端优先级：自定义 JSON 端点（`searchEndpoint` + `searchApiKey`，兼容 Tavily/Brave/Google/SearXNG 形状）> 百度（默认）> Bing RSS（自动兜底）。
- 百度：`https://www.baidu.com/s?ie=utf-8&rn=<n>&wd=<q>`。反爬/极小 stub 页面由 `isBaiduVerification` 检测，自动回退 Bing RSS。
- Bing RSS：`format=rss&setlang=zh-CN&cc=CN&mkt=zh-CN`。
- Token 效率上限：标题 120 字符、摘要 300 字符、结果数默认 5 / 最大 10；百度 snippet 用 `trimBaiduNoise` 清除内嵌 JSON 噪音。
- 环境变量：`WEB_SEARCH_PROVIDER` / `WEB_SEARCH_ENDPOINT` / `WEB_SEARCH_API_KEY`（`.env.example` 已补充说明）。

## 3. 测试与静态验证

- `tests/web-tools.test.ts`：12 个用例全过（schema 校验、SSRF、重定向、HTML→markdown 噪音剥离、RSS/Baidu 解析、normalize 多后端形状、验证页检测、端到端 meta-refresh + 正文提取、HTTP 错误）。
- 全量 `npm test`：149 通过。
- `node --check` 通过。

## 4. 真实 run 验证（隔离实例）

### 4.1 环境

- 独立实例：`PORT=8788`、`DATABASE_PATH=./data/verify-web.db`、空 `SKILL_DIRECTORY`（隔离 discovered skills 干扰，详见 5.2）。
- 新建用户 `verify-web@example.com`，直接发起 run（单 Agent 模型不再创建 agent；`webfetch`/`websearch` 作为非危险插件工具始终注册，无需 toolNames 配置，allowDangerousTools=false）。

### 4.2 任务与结果

任务：调研中国宝武近期 AI 与“数据底座”新闻（“超级智能体”进展），websearch + webfetch 至少 2 篇正文，输出 200-300 字中文摘要 + 来源 URL。

run `529f4789-8677-4658-9af0-f78b0a78e4fe`：**status = completed，耗时 171s**。

| 阶段 | 行为 | 指标 |
|---|---|---|
| plan | 2 步（search → fetch-and-summarize），评估全部批准 | — |
| search | ~14 次 websearch（百度后端），结果干净高相关（宝武 2526 工程、钢铁+AI、DeepSeek 部署） | 单条约 2.5KB |
| fetch | 3 个 webfetch **并行 0.5s 完成**，跟随百度 302 重定向拿到 Mysteel/新华网/新浪财经正文 | 抓取步上下文约 11K tokens |
| output | 270 字摘要 + 3 条真实 URL（`news.mysteel.com`、`xinhuanet.com`、`finance.sina.cn`） | — |

与失败 run `d122954c` 对比：同类宝武调研从“20 步耗死在 curl 研究、目标步骤从未启动”变为“2 步计划、全程 171s 完成、工具输出即用”。

### 4.3 Token 效率实测

- 搜索：3 条高相关结果序列化约 **951 字节（约 350 token）**。
- 抓取：66KB 百度百家号 HTML → **约 3KB markdown（4.6%，约 20 倍节省）**。

## 5. 验证中发现的问题

### 5.1 LLM 搜索策略浪费（工具无关，模型行为）

搜索步内模型发出约 14 次 websearch，其中多次为退化查询（如“锻造”“宝”“新华”“中国”），返回百科/门户泛结果。这是 LLM 的搜索策略问题：每次工具都返回干净结果，但模型反复重搜、从标题里拆单词再搜，烧掉预算。优化方向见 6。

### 5.2 用户级 Skill 解析会把全部 discovered skills 带入每个 Run

`src/skills/skill-service.ts` 的 `resolveForConversation(ownerUserId)` 返回该用户全部私有 Skill + 官方 `skills/` 目录发现结果（单 Agent 模型不再有 agent 级 `boundSkillIds` 过滤）。后果：`./skills` 下若有需要文件产出的 skill（如 canvas-design），无写工具的 run（`allowDangerousTools=false` 且步骤未要求写/命令工具）会在 `executeInternal` 中被 `PLAN_NOT_ADMITTED("The selected Skill requires file-producing tools...")` 拒绝。

本次验证用空 `SKILL_DIRECTORY` 隔离绕过；对需要文件产出的任务，应显式开启 `allowDangerousTools`（或让步骤声明写/命令工具）。

### 5.3 百度间歇性反爬

百度会间歇返回“百度安全验证”拦截页（曾实测 1438 字节 stub）。`isBaiduVerification` 检测该页面/极小 HTML 并自动回退 Bing RSS，保证搜索结果永远可用（代价：Bing 中文多词查询相关性明显弱于百度，故百度仍为默认）。

## 6. 后续优化方向（LLM 搜索策略）

### 6.1 已实施（2026-08-19，实现顺序 2a → 2b → 1b）

- **2a 工具描述注入搜索纪律**：`src/web/web-tools.ts` websearch `description` 增加“一次完整查询短语、不从标题拆词、用 numResults 扩大覆盖面、优先 webfetch 读正文、同主题避免重复搜索”。
- **2b 执行上下文研究纪律**：`src/runtime/run-service.ts` `buildStepRuntimeContext` 对含 `websearch`/`webfetch` 的步骤注入 `<researchDiscipline>` 段（每步最多 1-2 次搜索、一次搜索 numResults 覆盖、抓取 2-3 个 URL）。
- **1b 退化解拦截 + 同 run 查询缓存**：`src/web/web-tools.ts` `executeSearch` —— 查询不足 2 字符抛 `BAD_REQUEST`（提示改写完整查询短语）；按 `runId + query + numResults` 做有界缓存（每 run 24 条、全局 128 个 run，LRU 淘汰），同 run 内重复查询直接返回上次结果，不再发网络请求。新增测试：退化查询拒绝 + 重复查询缓存命中（测试用本地 searchEndpoint + 请求计数验证）。

### 6.2 未实施（可选项）

- **搜索步收敛条件**：为研究类步骤加 `shouldConvergeAfterToolStep`（≥1 次搜索返回结果且 ≥2 次 webfetch 成功后机械收敛），根治浪费而不依赖模型自觉。见 `src/runtime/agent-loop.ts` 的 `runAgentLoop` 调用点。
- **评估器辅助**：`src/planning/assessor.ts` 提示补充“证据充分时再次发起搜索视为不达标”。
- **模型选择**：检索类步骤绑定更经济的模型（provider 配置层）。
