# AgentLoop Skill Execution Manifest 编制说明

版本：v1.0
适用范围：Local Agent / AgentLoop Runtime Skill 包
文件名：`agentloop.executors.json`
当前 schema：`agentloop.skillExecutors/v1`

## 1. 这是什么

`agentloop.executors.json` 不是普通 Skill metadata，也不是授权配置。它是 Skill 对 Runtime 暴露的**结构化执行接口声明**：说明 Runtime 可以调用哪些包内入口、每个入口有哪些 action、需要哪些输入，以及会产生什么结果和 evidence。

普通 Skill 可以只有 `SKILL.md` 和 `agentloop.skill.json`。只有当 Skill 的核心能力依赖可重复调用的脚本或程序时，才需要增加 execution manifest。

```text
SKILL.md                         人和模型的工作说明
agentloop.skill.json             Skill 身份、语义 metadata、可选 execution 指针
agentloop.executors.json         Runtime 可调用的执行接口
scripts/*                        实际执行程序
```

`agentloop.skill.json` 中的 execution 字段只是指针：

```json
"execution": {
  "manifest": "agentloop.executors.json"
}
```

它不包含 command、参数或权限本身。

## 2. 什么时候应该编制 manifest

满足以下条件时建议编制：

- Skill 的关键判断或取数必须由确定性程序完成；
- Skill 需要固定的 command、script 和参数结构；
- 输出需要作为后续工作流的结构化 evidence；
- 不能允许模型自行拼接命令或自行解释原始数据；
- 需要记录 action、输入、输出和退出状态，以支持审计、恢复或重放。

以下情况不应为了“看起来完整”而编制：

- 只有知识说明、写作、分析方法或业务规则，没有稳定程序入口；
- `scripts/` 目录只是作者维护 Skill 文档的工具；
- 脚本是复杂的临时实验，尚未定义稳定输入输出契约；
- 只能由人工在特定机器环境中运行，尚未确定 Runtime 的工作目录和依赖。

仅仅存在 `scripts/*.py`、`scripts/*.js` 不足以证明需要 manifest。脚本文件是实现线索，manifest 才是经过作者确认的公共接口。

## 3. 当前完整结构

```json
{
  "schema": "agentloop.skillExecutors/v1",
  "executors": [
    {
      "id": "example-query",
      "description": "Read bounded records from the configured source.",
      "command": "python3",
      "script": "scripts/query.py",
      "actions": [
        {
          "id": "query",
          "description": "Return records for an approved bounded request.",
          "inputs": [
            {
              "name": "request-json",
              "description": "JSON request using the Skill's approved request shape.",
              "required": true
            }
          ],
          "args": ["query", "--request-json", "{{request-json}}"],
          "result": "A bounded response with source receipt and coverage details.",
          "producesEvidenceKinds": ["source_summary", "structured_extraction_artifact"]
        }
      ]
    }
  ]
}
```

### 3.1 根对象

| 字段 | 要求 |
|---|---|
| `schema` | 必须是 `agentloop.skillExecutors/v1` |
| `executors` | 数组，当前允许 1–16 个 executor |

### 3.2 executor

| 字段 | 要求 |
|---|---|
| `id` | 唯一的 lowercase kebab-case 标识，例如 `hr-report-data-query` |
| `description` | 说明整个入口解决什么问题，最多 500 个字符 |
| `command` | 裸可执行文件名，例如 `python3`、`node`；不能包含 `/`、`\\`、空格或参数 |
| `script` | Skill 包内相对路径，例如 `scripts/query.py`；不能是绝对路径，不能包含 `..` |
| `actions` | 数组，当前允许 1–32 个 action，id 必须唯一 |

`command` 和 `script` 必须分开写：

```json
"command": "python3",
"script": "scripts/check_md_completeness.py"
```

不要写成：

```json
"command": "python3 scripts/check_md_completeness.py --batch"
```

### 3.3 action

| 字段 | 要求 |
|---|---|
| `id` | executor 内唯一的 lowercase kebab-case 标识 |
| `description` | 说明 action 的实际语义和边界，最多 500 个字符 |
| `inputs` | 0–16 个输入；名称唯一 |
| `args` | 最终传给脚本的参数模板，1–32 项 |
| `result` | 说明成功输出和语义，最多 500 个字符 |
| `producesEvidenceKinds` | 可选；声明该 action 实际产生的 evidence 类型 |
| `decisionBinding` | 可选；只有 action 输入承载 Runtime 决策时使用 |

每一个 input 都必须在 `args` 中以 `{{input-name}}` 出现。这样 Runtime 能检查“声明的输入”和“真正传给脚本的输入”是否一致。

## 4. 输入和参数如何设计

### 4.1 输入只描述业务参数，不描述内部路径

推荐：

```json
{
  "name": "target",
  "description": "The Markdown report to validate.",
  "required": true
}
```

不推荐把机器绝对路径写入 manifest：

```json
{
  "name": "/Users/example/report.md",
  "description": "local path",
  "required": true
}
```

Runtime 会把工作区路径解析为当前 Run 的实际路径。Skill 作者只应声明输入的业务含义和相对路径语义。

### 4.2 参数必须是脚本真正支持的参数

如果脚本支持：

```bash
python scripts/check_md_completeness.py report.md -o output.md
```

manifest 才能写：

```json
"args": ["{{target}}", "-o", "{{output}}"]
```

不要为了让 action 看起来更通用，添加脚本并不支持的参数，也不要把自然语言说明当作参数模板。

### 4.3 多种模式应拆成多个 action

对于单文件和批量模式，建议分别声明：

```text
validate-file
validate-batch
```

不要让一个 action 接收一个含糊的 `mode`，再让模型自行决定需要哪些参数。拆分后每个 action 的输入、输出和 evidence 都更清晰。

### 4.4 `required` 的含义

- `required: true`：每次调用 action 都必须由调用方提供；
- `required: false`：参数可以省略，但仍然必须在 `args` 模板中声明；
- 如果省略后会导致命令参数结构不合法，应把它设计为 required，或拆成不同 action。

### 4.5 evidence 输入

如果某个输入是需要由 Runtime 捕获和绑定的不可变工作区文件，可以声明：

```json
{
  "name": "report",
  "description": "The immutable report artifact being checked.",
  "required": true,
  "evidenceInput": "immutable_workspace_artifact"
}
```

该输入必须是 required，并且必须作为一个完整参数传给脚本。不要把 Skill 自身的脚本路径声明为 evidence input。

## 5. result 和 evidence 如何编制

### 5.1 `result` 描述输出契约，不是成功口号

差的写法：

```json
"result": "校验成功"
```

好的写法：

```json
"result": "A validation report containing ERROR, WARNING and INFO findings, with the process exit code indicating whether ERROR findings exist."
```

应说明：

- 输出是什么格式；
- 输出是否包含来源、覆盖范围或统计信息；
- 退出码如何解释；
- 输出是否供后续 Skill 使用。

### 5.2 `producesEvidenceKinds`

只声明 action 实际能够产生的 evidence，不要根据 Skill 的最终业务目标臆测。

当前 metadata contract 中的标准 evidence 类型包括：

```text
source_summary
source_urls
schema_summary
record_counts
table_coverage
structured_extraction_artifact
explicit_caveats
```

现有分析类 manifest 还使用过 `derived_aggregation`。它目前是 execution manifest 层面的标识，尚未进入 `agentloop.skill.json` compatibility 的固定枚举；新增 Skill 时不要随意扩大枚举，若需要成为跨 Skill 的正式 evidence 类型，应先更新统一 contract 和校验。

### 5.3 不要把执行权限伪装成 evidence

以下内容不是 evidence 类型：

- `can_write_file`
- `has_network`
- `can_execute_python`
- `database_access`

这些属于执行环境和授权边界，不应写入 `producesEvidenceKinds`。

## 6. `decisionBinding` 何时使用

只有当 action 的输入明确承载 Runtime 已确认的结构化决策时，才使用 `decisionBinding`。

可绑定的输入类别包括：

```json
"decisionBinding": {
  "labelInputs": ["label"],
  "identityRefInputs": ["identity-ref"],
  "selectedOptionIdInputs": ["option-id"]
}
```

不要把普通查询词、文件路径或筛选条件都标成 decision binding。它表达的是“这个输入必须来自 Runtime 已提交的人机决策”，不是普通参数校验。

## 7. `agentloop.skill.json` 如何配套

只有在 manifest 合法并且该 Skill 确实需要 Runtime 执行接口时，才在声明中加入：

```json
"execution": {
  "manifest": "agentloop.executors.json"
}
```

同时满足：

1. 两个文件位于同一个 Skill 根目录；
2. `script` 指向的文件存在于包内；
3. `SKILL.md` 与 manifest 对 action 语义的描述一致；
4. `agentloop.skill.json` 的 identity 与 `SKILL.md` frontmatter 一致；
5. 包上传后，两个文件都属于原始包内容并参与 `packageHash`。

没有 manifest 时不要生成空对象：

```json
"execution": {}
```

应该直接省略 `execution` 字段。`execution: null` 只适合作为已有迁移数据的显式空值，不建议新包使用。

## 8. 以 `shutu-ods-analysis-validate` 为例

该 Skill 的核心契约是：校验逻辑必须由 Python 程序完成，Agent 不能自行判断报告是否合格。

因此可以设计两个 action：

```text
validate-file
  输入：target、output
  调用：python3 scripts/check_md_completeness.py {{target}} -o {{output}}
  结果：单文件校验 Markdown

validate-batch
  输入：target-directory、summary-md、csv
  调用：python3 scripts/check_md_completeness.py {{target-directory}} --batch --summary-md {{summary-md}} --csv {{csv}}
  结果：批量汇总 Markdown 和 ERROR 文件 CSV
```

这会带来：

- Runtime 能区分单文件和批量校验；
- 模型不能把两个模式混用；
- 输入和输出路径可以绑定到当前 Run workspace；
- 退出码和生成报告可以纳入执行记录；
- 后续 `shutu-ods-report-qc` 或 `shutu-ods-ddm-modeling` 可以依赖明确的校验产物。

但 manifest 不会自动生成校验规则，也不会替代 `check_md_completeness.py`。规则仍由 Skill 作者维护，manifest 只声明如何安全、稳定地调用它。

## 9. 编制流程

### 第一步：确认是否真的需要执行接口

回答：如果不调用这个脚本，Skill 的核心结果是否仍然成立？

- 是：通常不需要 manifest；
- 否：继续编制。

### 第二步：从现有 CLI 提取契约

逐项确认：

- 稳定的入口脚本；
- 裸 command；
- 每种工作模式；
- 必填输入；
- 输出路径和格式；
- 退出码语义；
- 可产生的 evidence。

### 第三步：按 action 拆分

一个 action 应完成一个边界清晰、可以独立审计的操作。不要把完整业务流程和多个互不相关的命令塞进一个 action。

### 第四步：编写 manifest 和 declaration

先写 manifest，再将指针写入 `agentloop.skill.json`。不要先在 declaration 里声明 execution，最后才补文件。

### 第五步：执行校验

至少验证：

- JSON 格式正确；
- schema 正确；
- executor/action/input id 唯一；
- script 存在且路径安全；
- 每个 input 都有对应 `{{placeholder}}`；
- 每个 placeholder 都能被脚本正确消费；
- 脚本在 Runtime 的执行 cwd 下可运行；
- 输入输出不会写入只读 Skill 包；
- evidence 与实际输出一致。

### 第六步：添加回归测试

至少覆盖：

- manifest 可以成功解析；
- 非法 command、script、args 会失败；
- 缺少 required input 会失败；
- action 执行成功时输出符合 result 契约；
- 脚本退出码为失败时 Runtime 不得伪装成成功；
- 生成的 evidence 与输入 package/workspace 绑定正确。

## 10. 常见错误

### 错误一：把所有脚本都暴露成 action

维护脚本、一次性迁移脚本、调试脚本不应自动进入 Runtime 接口。

### 错误二：让模型自动生成 command、script 或 args

模型可以帮助生成草稿，但最终 manifest 是可执行接口，必须经过确定性校验和作者确认。缺少可信证据时宁可不声明 execution。

### 错误三：把 manifest 当作权限声明

manifest 描述调用接口，不授予网络、数据库、文件系统或 Secret 权限。权限必须由 Runtime、配置和部署环境单独控制。

### 错误四：输入名称与参数模板不一致

声明了 `request-json`，但 args 使用 `{{request}}`，会导致 Runtime 无法可靠绑定。

### 错误五：把脚本路径放进 `computationInputs`

脚本是执行入口，不是任务数据。任务数据、报告文件和生成结果应通过 workspace 参数传入。

### 错误六：manifest 声明了不存在的 evidence

只有 action 实际产生并可被 Runtime 记录的 evidence 才能声明。

## 11. 最终检查清单

```text
[ ] Skill 确实需要确定性脚本执行
[ ] agentloop.executors.json 使用 agentloop.skillExecutors/v1
[ ] executor 数量和 action 数量在当前限制内
[ ] id 全部为唯一 lowercase kebab-case
[ ] command 是裸可执行文件名
[ ] script 是包内安全相对路径
[ ] 每个 input 都在 args 中有 {{placeholder}}
[ ] required 与脚本真实参数要求一致
[ ] result 描述真实输出，不写空泛成功语句
[ ] producesEvidenceKinds 只声明真实产物
[ ] 不把 manifest 当作授权配置
[ ] agentloop.skill.json 的 execution 指针与文件一致
[ ] SKILL.md、declaration、manifest 三者语义一致
[ ] 单元测试和实际 Runtime action 测试通过
```

## 12. 核心原则

```text
没有稳定执行契约，就不要编制 manifest。
有稳定执行契约，就把它声明成最小、明确、可验证的 action 接口。
模型可以提出草稿，但不能未经确认生成可执行权限和隐含能力。
```
