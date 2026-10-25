# Local Agent Skill 上传与自动 Metadata 生成方案

版本：v1.0-draft
日期：2026-10-25
状态：设计方案
范围：Local Agent 上传 ZIP/目录、metadata 自动识别与可选维护

## 1. 结论

Local Agent 上传 Skill 后应立即完成导入，不要求用户确认或编辑 metadata。

处理规则：

1. 包中已有 metadata 时，原样保留并直接使用；
2. 包中没有 metadata 时，自动生成默认 metadata；
3. 自动生成先使用确定性识别，再使用当前第一个可用的本地/云端模型补充语义字段；
4. 用户维护 metadata 是上传完成后的可选最后一步；
5. 原始 Skill 包不可变，metadata 修改不改变 packageHash；
6. metadata 只能描述 Skill 能力，不能单独授予脚本、网络、MCP、文件写入或 secret 访问权限；
7. 页面和后端必须使用当前实现已有的枚举值和校验规则。

核心边界：

~~~text
自动识别/生成 metadata != 用户确认
metadata != 执行授权
上传成功 != Runtime 绑定
Runtime 绑定 != Runtime readiness
~~~

## 2. 当前实现基础与必须修正的边界

当前实现已经具备：

- /v1/local-skill-package-uploads ZIP 和目录上传；
- validateSkillArchive() 归档安全检查；
- inspectSkillPackage() 包结构、文件清单、大小和 hash 检查；
- agentloop.skill.json 包内声明；
- legacy SKILL.md agentloop: 解析；
- parseSkillDeclaration() declaration 校验；
- 本地模型目录和云端模型复用配置；
- metadata 查询和更新 API；
- Runtime 级 Skill 绑定。

当前上传路径不能为了生成 metadata 而改写用户包。生成 sidecar、删除 legacy frontmatter 后再计算 hash，会使 hash 代表改写后的包，而不是用户上传的原始包。

因此本方案规定：自动生成 metadata 存储在包外；只有包作者原本携带的 agentloop.skill.json 才属于包内容。

### 2.1 包内声明与生效 revision 的职责边界

这里存在两份物理数据，但只有一份运行时生效数据：

- 包内 `agentloop.skill.json` 是作者声明，属于不可变 Package Artifact 的一部分，参与 `packageHash`，上传后只读；
- `local_skill_metadata_revisions` 是 Local Agent 的统一 metadata 存储。上传时把包内声明、legacy 投影或自动生成结果物化为 revision 1，页面、Runtime 和后续用户编辑都只读取 active revision；
- 用户编辑只新增 revision，不回写包内文件，也不改变 `packageHash`。因此 revision 是运行时唯一生效来源，包内声明只是不可变输入和审计依据；
- 需要重新得到带新 metadata 的 Skill 包时，必须显式执行导出/打包，生成新的 Package Artifact，而不是把页面编辑隐式写回原包。

`metadataSource` 表示 revision 1 的原始来源（`package`、`legacy-frontmatter` 或 `detected`）；用户编辑使用 `generationMethod = user`，但不覆盖这个来源信息。

## 3. 总体流程

~~~text
上传 ZIP/目录
  -> 隔离区解包与安全检查
  -> 识别一个或多个 Skill 根目录
  -> 计算原始 packageHash
  -> 检查包内 metadata
       ├── 有 agentloop.skill.json
       │     -> 读取、校验、保留
       ├── 有 legacy agentloop frontmatter
       │     -> 读取并投影，不修改 SKILL.md
       └── 没有 metadata
             -> 确定性识别
             -> 选择第一个可用模型补充建议
  -> 保存不可变 PackageRecord
  -> 保存 active metadata revision
  -> 注册 Local Agent Skill
  -> 用户可选维护 metadata
~~~

用户不进行任何操作时，自动生成的 metadata 就是当前生效版本。

## 4. Metadata 来源优先级

### 4.1 原生 agentloop.skill.json

包中存在合法 sidecar 时：

- 直接读取并校验；
- 不调用模型；
- 不生成新的 sidecar；
- 不覆盖原文件；
- 保留原始 package hash。

~~~text
metadataSource = package
generationMethod = none
review = optional
~~~

### 4.2 Legacy SKILL.md agentloop:

包中没有 sidecar、但 SKILL.md 中存在旧块时：

- 读取旧 metadata；
- 使用 declarationFromLegacyMetadata() 投影为当前 declaration；
- 不修改或删除 SKILL.md；
- 不调用模型。

~~~text
metadataSource = legacy-frontmatter
generationMethod = legacy-projection
review = optional
~~~

### 4.3 完全没有 metadata

1. 先进行确定性识别；
2. 再调用第一个可用模型补充语义字段；
3. 结果保存为包外 metadata revision；
4. 不修改原始包；
5. 模型失败时保留确定性识别结果，上传仍成功。

~~~text
metadataSource = detected
generationMethod = deterministic | model | deterministic+model
review = optional
~~~

## 5. 当前可用的 Metadata 字段

页面、模型输出和后端校验必须复用 agentloop-metadata.ts 中的现有常量。

### 5.1 必选多选字段

roles：

~~~text
primary_builder
source_provider
support
qa
~~~

至少选择一个。

artifactKinds：

~~~text
html
document
presentation
spreadsheet
image
audio
code
none
~~~

至少选择一个；none 表示 Skill 不负责直接生成文件。

### 5.2 可选多选字段

sourceKinds：

~~~text
api
database
dataset
document
repository
rubric
web
~~~

qaKinds：

~~~text
browser
content
openability
playwright
visual
~~~

producesEvidenceKinds：

~~~text
source_summary
source_urls
schema_summary
record_counts
table_coverage
structured_extraction_artifact
explicit_caveats
~~~

有 executor manifest 时，evidence 优先从 manifest 推导。页面可以展示当前值，但不允许输入不存在的 evidence kind。

requiredSkillNames 不是固定枚举，而是从当前已发现的 Skill 中多选；每个名称必须符合：

~~~text
^[a-z0-9]+(?:-[a-z0-9]+)*$
~~~

最多 32 个。

### 5.3 可编辑文本字段

semanticTags 每项必须符合：

~~~text
^[a-z0-9][a-z0-9._-]{0,63}$
~~~

最多 32 项。

intentExamples 最多 16 条，每条最多 500 个字符。

### 5.4 只读 identity 字段

name 属于 package identity，使用当前 name pattern，最长 80 个字符；description 属于 package identity，最长 2000 个字符。二者在 metadata 页面只读。

如需修改 identity，应生成新的 package revision；本期不在普通 metadata 编辑流程中修改。

### 5.5 executionProfiles

当前实现只允许：

~~~text
local_script
~~~

它是兼容字段，不应设计成开放式输入。存在 agentloop.executors.json 时，页面优先展示 manifest action。

## 6. 自动生成策略

### 6.1 确定性识别

识别内容包括：

- 包内 declaration 和 legacy metadata；
- name、description、SKILL.md 标题和章节；
- 文件扩展名和相对路径；
- scripts 目录和脚本文件名；
- executor manifest；
- 当前 Skill 文件清单。

没有可靠线索时，沿用当前保守策略：role 为 support，artifact 为 none，sourceKinds 和 qaKinds 为空，tags 从 name 提取，intent example 使用 description。

确定性识别不能授予执行权限。

### 6.2 模型补充

模型只在完全没有 metadata 时调用，用于建议：

~~~text
roles
artifactKinds
sourceKinds
qaKinds
semanticTags
intentExamples
~~~

模型不能自由生成 name、description、command、script、executor action、MCP source、configuration ref、secret 或 evidence producer。requiredSkillNames 只有匹配现有 Skill catalog 时才接受。

### 6.3 合并优先级

~~~text
package declaration
  > legacy frontmatter
  > user metadata revision
  > deterministic detection
  > model suggestion
~~~

对于无 metadata 的包，确定性结果是基础值，模型只补充或替换低置信度字段。模型非法或冲突的字段被丢弃，保留确定性结果并记录原因。

## 7. 本地/云端模型选择

### 7.1 候选顺序

复用 Local Agent 当前模型目录顺序：

~~~text
本地模型
  -> 云端模型
~~~

具体顺序：

1. 本地 provider 按保存配置顺序；
2. provider 内 model 按保存配置顺序；
3. 当 reuseCloudModels === true 时，追加云端模型；
4. 云端模型顺序使用云端 catalog 返回顺序；
5. reuseCloudModels === false 时不得尝试云端模型。

模型 key 使用当前格式：

~~~text
local:<model-key>
cloud:<model-key>
~~~

### 7.2 可用性判断

模型配置存在不等于调用一定成功。因此不单独增加一套模型 health check，而是按顺序实际尝试一次受限的 metadata generation 调用：

- 第一个成功返回合法结果的模型生效；
- 失败后尝试下一个；
- 全部失败时回退到确定性识别。

调用设置独立的短超时和最大输出限制，不能长时间阻塞 Skill 上传。

### 7.3 生成记录

~~~ts
interface LocalSkillMetadataGeneration {
  readonly method: "none" | "legacy-projection" | "deterministic" | "model" | "deterministic+model";
  readonly modelKey?: string;
  readonly attemptedModelKeys?: readonly string[];
  readonly status: "not-needed" | "completed" | "fallback" | "failed";
  readonly errorCode?: string;
  readonly createdAt: number;
}
~~~

不记录 API key、完整 prompt、完整模型输出或私密文件内容。

## 8. 模型输入安全边界

发送给模型的内容只包括：

- SKILL.md 正文；
- name、description；
- 相对文件路径清单；
- executor manifest 的非敏感结构；
- 确定性识别结果。

不得发送：

- .env 内容；
- API key、token、password；
- 私钥、证书；
- 本地绝对路径；
- 二进制文件内容；
- 用户运行时数据；
- MCP header 和凭据。

当前 Local Agent 即使允许用户包携带私有文件，metadata generator 也不得读取这些文件的内容。

## 9. Package 与 Metadata 存储

### 9.1 Package Store

继续使用当前上传存储形式：

~~~text
skill-packages/uploaded/uploaded-<packageHash>/
~~~

要求：

- package hash 基于原始包内容；
- 原生 agentloop.skill.json 参与 hash；
- 自动生成 metadata 不写入包；
- legacy SKILL.md 不被删除或重写；
- metadata 修改不改变 packageHash；
- 同一 hash 的包可安全复用。

### 9.2 Metadata Revision

建议新增本地表：

~~~sql
CREATE TABLE IF NOT EXISTS local_skill_metadata_revisions (
  package_id TEXT NOT NULL,
  package_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  metadata_source TEXT NOT NULL,
  generation_method TEXT NOT NULL,
  declaration_json TEXT NOT NULL,
  field_metadata_json TEXT NOT NULL,
  generation_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'invalid')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(package_id, revision),
  FOREIGN KEY(package_id) REFERENCES local_skill_packages(package_id)
);
~~~

local_skill_packages.manifest_json 继续保存列表展示摘要，但不再作为可变 metadata 的唯一来源。

### 9.3 字段来源

~~~ts
interface LocalSkillMetadataField {
  readonly value: unknown;
  readonly origin: "package" | "legacy" | "detected" | "suggested" | "user";
  readonly confidence?: "high" | "medium" | "low";
  readonly editable: boolean;
  readonly evidence: readonly string[];
}
~~~

用户修改后只创建新的 metadata revision：

~~~text
packageHash 不变
metadata revision + 1
declaration hash 改变
旧 revision 保留审计
~~~

## 10. Local Agent API

### 10.1 上传

保留：

~~~text
POST /v1/local-skill-package-uploads
~~~

支持当前两种输入：

- ZIP 的 contentBase64；
- directory files。

返回结果建议扩展为：

~~~json
{
  "skills": [
    {
      "packageId": "local_skill_xxx",
      "skillName": "example-skill",
      "packageHash": "...",
      "metadata": {
        "source": "detected",
        "generationMethod": "deterministic+model",
        "review": "optional",
        "modelKey": "local:qwen2.5"
      }
    }
  ]
}
~~~

上传成功不依赖用户确认 metadata。

### 10.2 查询与更新

保留现有接口：

~~~text
GET /v1/local-skill-packages
GET /v1/local-skill-packages/:packageId/metadata
PUT /v1/local-skill-packages/:packageId/metadata
~~~

查询接口返回：

- package identity；
- 当前 declaration；
- 字段来源、置信度和证据；
- generation 记录；
- 当前 revision；
- editable 信息。

更新接口：

- 用户可以不调用；
- 调用时创建新的 metadata revision；
- 使用现有 declaration parser 和枚举校验；
- name、description 修改拒绝；
- package hash 不变；
- 旧 revision 保留。

本期不增加确认上传接口。上传本身完成导入，metadata 页面属于后续可选维护。

## 11. 页面设计

上传完成后显示：

~~~text
Skill 已导入
Metadata 已自动生成/已读取
你可以稍后维护，当前配置已经可以使用
~~~

页面字段分组：

1. 基本信息：name、description，只读；
2. 工作流能力：roles、artifactKinds，多选；
3. 来源与 QA：sourceKinds、qaKinds，多选；
4. 召回提示：semanticTags、intentExamples；
5. 依赖 Skill：requiredSkillNames，从当前 Skill 列表多选；
6. 执行信息：manifest actions、local_script、evidence kinds。

每个字段展示当前值、来源、置信度、推导证据和是否可编辑。

前端不得维护第二套枚举，应复用：

~~~ts
SKILL_AGENT_LOOP_ROLE_VALUES
SKILL_AGENT_LOOP_ARTIFACT_KIND_VALUES
SKILL_AGENT_LOOP_SOURCE_KIND_VALUES
SKILL_AGENT_LOOP_QA_KIND_VALUES
SKILL_AGENT_LOOP_EXECUTION_PROFILE_VALUES
SKILL_AGENT_LOOP_PRODUCED_EVIDENCE_KIND_VALUES
SKILL_AGENT_LOOP_METADATA_FIELDS
~~~

## 12. Runtime 边界

metadata 生成后，Skill 可以出现在 Local Agent Skill 列表中，但不能因此自动绑定到所有 Runtime。

继续保持：

~~~text
上传成功 != Runtime 绑定
Runtime 绑定 != 执行授权
~~~

具体规则：

- reference/support 类默认 metadata 可以用于发现和加载指令；
- source_provider 不自动获得网络、数据库或 MCP 权限；
- 有脚本的 Skill 必须同时经过 executor manifest、Runtime policy 和 readiness；
- metadata 不能扩大 ToolRegistry、Admission 或 Run/Step grant；
- metadata 修改后，如影响 capability 或 readiness，需要重新检查当前 Runtime contract。

## 13. 代码调整范围

### 13.1 共享 Skill 核心

目录：

~~~text
packages/agentloop/src/skills/
~~~

建议新增：

~~~text
skill-metadata-draft.ts
skill-metadata-generator.ts
skill-metadata-fields.ts
~~~

职责：

- 复用当前枚举；
- 生成 deterministic draft；
- 解析模型结构化输出；
- 字段来源和证据记录；
- declaration 校验；
- declaration projection。

### 13.2 上传器

文件：

~~~text
apps/agentloop-multi-runtime/local-agent-runtime/src/service/local-skill-package-installer.ts
~~~

需要调整：

- 删除上传阶段的 materializeSkillDeclaration()；
- 删除上传阶段的 removeLegacyAgentLoopBlock()；
- 保留原始 SKILL.md；
- 原始包 hash 计算完成后，再独立生成 metadata；
- 返回 package inspection 和 metadata input，而不是修改后的包。

### 13.3 Local Agent Service

文件：

~~~text
apps/agentloop-multi-runtime/local-agent-runtime/src/service/local-agent-service.ts
apps/agentloop-multi-runtime/local-agent-runtime/src/persistence/local-runtime-configuration-store.ts
apps/agentloop-multi-runtime/local-agent-runtime/src/persistence/local-model-configuration-store.ts
~~~

建议增加统一模型解析接口：

~~~ts
interface MetadataModelResolver {
  orderedModelKeys(): Promise<readonly string[]>;
  generate(input: MetadataGenerationInput): Promise<MetadataGenerationResult>;
}
~~~

普通 Run 和 metadata generation 应共用本地/云端模型解析规则，避免两套模型选择逻辑。

### 13.4 前端

文件：

~~~text
apps/agentloop-multi-runtime/web/client/app.js
~~~

增加 metadata 来源、模型来源、字段化编辑器、枚举多选、文本输入校验、optional save 和 revision 更新提示。

## 14. 错误与回退

以下情况不应阻止包导入：

- 没有可用模型；
- 本地模型调用失败；
- 云端模型调用失败；
- 模型返回不可解析结果；
- 模型返回未知枚举。

这些情况回退到确定性 metadata，并记录：

~~~text
generation.status = fallback | failed
~~~

以下情况必须拒绝导入：

- 包路径越界；
- 符号链接；
- 非普通文件；
- 超过文件、压缩包或总大小限制；
- 缺少 SKILL.md；
- native declaration 非法；
- declaration identity 与 SKILL.md 不一致；
- executor manifest 结构非法。

## 15. 测试与验收

### 15.1 Metadata 来源

1. 有 agentloop.skill.json：不调用模型，声明内容不变；
2. 有 legacy frontmatter：不调用模型，SKILL.md 不变；
3. 无 metadata：生成 deterministic metadata；
4. 无 metadata 且模型成功：记录模型来源和字段来源；
5. 无 metadata 且模型失败：导入成功，保留 deterministic metadata。

### 15.2 Package 不可变

1. 自动生成 metadata 后原始 package hash 不变；
2. 自动生成 metadata 不产生新的 sidecar；
3. legacy frontmatter 不被删除；
4. 用户编辑 metadata 不改变 package hash；
5. 同一原始包重复上传可以复用 package store。

### 15.3 模型选择

1. 本地模型按当前 provider/model 顺序优先；
2. reuseCloudModels=false 时不调用云端；
3. 本地模型失败后可以尝试云端；
4. 第一个成功模型被记录为 modelKey；
5. 所有模型失败时仍完成导入。

### 15.4 字段校验

1. 未知 role 被拒绝；
2. 未知 artifact kind 被拒绝；
3. 未知 source、QA 或 evidence kind 被拒绝；
4. 必填多选为空被拒绝；
5. tag、intent example、Skill name 超长被拒绝；
6. name/description 修改被拒绝；
7. required Skill 不存在时进入 unresolved，不自动激活。

### 15.5 安全

1. .env、私钥和证书内容不进入模型输入；
2. metadata generation 日志不包含 secret；
3. 模型不能生成 command、MCP 凭据或任意路径；
4. metadata 不扩大 Runtime capability grant。

### 15.6 多 Skill 上传

1. 每个 Skill 独立计算 hash；
2. 每个 Skill 独立识别 metadata；
3. 模型失败只影响对应 Skill；
4. 返回顺序稳定；
5. 同一 ZIP 中不同 Skill 不共享错误 metadata。

## 16. 推荐实施顺序

1. 修改上传器：停止改写 SKILL.md 和自动写入 sidecar；
2. 保留原始 package hash 和原始包内容；
3. 增加 metadata revision 存储；
4. 将现有 deterministic detection 改为 draft 结果；
5. 抽取统一本地/云端模型解析器；
6. 接入模型补充 metadata 和 fallback；
7. 扩展上传 API 返回 generation 信息；
8. 实现 metadata 查询和可选编辑页面；
9. 增加 package、model、field、security 和 multi-Skill 测试；
10. 最后再将 metadata revision 接入更完整的 Runtime contract/readiness 流程。

最终行为：

~~~text
有 metadata：直接使用
无 metadata：自动生成
模型不可用：仍可导入
用户不操作：仍可使用
用户要修改：最后一步可选维护
原始包：始终保持不可变
~~~
