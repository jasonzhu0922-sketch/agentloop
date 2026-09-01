# Production Assessment Model

Use this model as the default City Carbon evaluation rubric unless the user supplies a different model.

## Provenance

This model snapshot was captured on `2026-08-27`.

```text
source: City Carbon assessment model snapshot
selection: default published model and enabled indicators
```

Default model:

```text
id=2
version_code=V1.11
version_name=城市碳评估模型2
is_default=1
status=published
remark=[legacy 10-point import]
```

Important boundary: use this snapshot as the default rubric unless the user supplies a different assessment model for the current task.

## Model Version

| Field | Value |
| --- | --- |
| id | `2` |
| versionCode | `V1.11` |
| versionName | 城市碳评估模型2 |
| status | `published` |
| isDefault | `1` |
| scoreScale | 0-10 |

## Dimensions

Dimension weights are whole-model weights and are used by the assessment engine when aggregating indicator scores.

| Dimension | Name | Weight | Sort |
| --- | --- | ---: | ---: |
| D1 | 建筑部门 | 0.2850 | 1 |
| D2 | 交通部门 | 0.3103 | 2 |
| D3 | 城市环境部门 | 0.2319 | 3 |
| D4 | 管理部门 | 0.1728 | 4 |

## Indicators

`indicatorWeight` is the indicator's weight inside its dimension. `totalWeight` is computed from the model snapshot as:

```text
totalWeight = dimensionWeight * indicatorWeight
```

Use `totalWeight` when explaining contribution to the whole project. Use the source dimension and indicator weights when reproducing the model scoring behavior.

| Dimension | Indicator | Name | Indicator Weight | Total Weight | Calculation Method | Evaluation Standard | Contribution Summary | Evidence Requirements |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| D1 建筑部门 | I101 | 获绿色评级建筑所占比例 | 0.3660 | 0.104310 | 获绿色建筑评级项目数量/全部项目数量。 | `<5%：2分；5%—10%：4分；10%—20%：6分；20%—30%：8分；>30%：10分。` | 反映片区建筑系统达到绿色建筑标准的程度。 | 按本 Skill 的上传材料证据边界执行。 |
| D1 建筑部门 | I102 | 可再生能源利用情况 | 0.3923 | 0.111805 | 条目累积法：设施配置、替代应用、系统集成、运行成效、持续运行。 | 每满足1项计2分，满分10分：是否建有可再生能源设施；是否形成较为稳定的能源替代应用；是否在站房、公共建筑或片区能源系统中实现集成；是否具有公开可识别的运行成效；是否形成示范性或持续运行特征。 | 反映片区对太阳能、地热能、热泵等可再生能源的应用水平。 | 按本 Skill 的上传材料证据边界执行。 |
| D1 建筑部门 | I103 | 有/无余热利用项目 | 0.2414 | 0.068799 | 二元判定 | 有：10分；无：0分。 | 反映是否实现区域能源耦合与余热梯级利用。 | 按本 Skill 的上传材料证据边界执行。 |
| D2 交通部门 | I201 | 充电站配置水平 | 0.2888 | 0.089615 | 充电站数量/研究范围面积（个/km²）。 | `<5：2分；5—10：4分；10—15：6分；15—20：8分；>20：10分。` | 反映新能源交通基础设施配置程度。 | 按本 Skill 的上传材料证据边界执行。 |
| D2 交通部门 | I202 | 慢行路网密度 | 0.3474 | 0.107798 | 慢行路网长度/研究范围总面积（km/km²）。 | `<12：2分；12—15：4分；15—18：6分；18—21：8分；>21：10分。` | 反映步行与自行车网络的细密程度和连续性。 | 按本 Skill 的上传材料证据边界执行。 |
| D2 交通部门 | I203 | 公共交通覆盖率 | 0.3645 | 0.113104 | 公交站点300m服务范围覆盖面积/研究范围总面积。 | `<70%：2分；70%—80%：4分；80%—90%：6分；90%—95%：8分；>95%：10分。` | 反映公交与轨道站点对片区空间的服务水平。 | 按本 Skill 的上传材料证据边界执行。 |
| D3 城市环境部门 | I301 | 绿化覆盖率 | 0.4480 | 0.103891 | 绿化（含水系）面积/研究范围总面积。 | `<5%：2分；5%—10%：4分；10%—15%：6分；15%—20%：8分；>20%：10分。` | 反映生态基底完整性及绿地、水系对碳汇与环境调节的支撑能力。 | 按本 Skill 的上传材料证据边界执行。 |
| D3 城市环境部门 | I302 | 用地混合度 | 0.5520 | 0.128009 | 归一化香农熵 | `<0.55：2分；0.55—0.65：4分；0.65—0.75：6分；0.75—0.85：8分；>0.85：10分。` | 反映片区功能复合程度及其对出行距离压缩和设施共享的促进作用。 | 按本 Skill 的上传材料证据边界执行。 |
| D4 管理部门 | I401 | 片区智能调控系统运行情况 | 0.6186 | 0.106894 | 条目累积法：在线监测、自动控制、联动调度、可视化平台、常态运行。 | 每满足1项计2分，满分10分：是否具备能耗或环境在线监测；是否具备楼宇设备或机电系统自动控制；是否形成多系统联动调度；是否具有可视化平台或数据看板；是否在日常运维中形成常态化运行机制。 | 反映片区监测、联动控制和运维优化能力。 | 按本 Skill 的上传材料证据边界执行。 |
| D4 管理部门 | I402 | 地方碳普惠政策实施情况 | 0.3808 | 0.065802 | 条目累积法：总体方案、管理办法、平台/账户、激励场景、实际运行。 | 每满足1项计2分，满分10分：是否发布碳普惠总体方案；是否出台管理办法或实施细则；是否形成方法学、平台或账户机制；是否设置激励场景与兑换机制；是否形成实际运行和推广应用。 | 反映地方制度环境对片区低碳治理的支撑程度。 | 按本 Skill 的上传材料证据边界执行。 |

## Calculation Rules

Evaluate every enabled indicator independently, then resolve final scores with:

```text
manualScore -> aiScore -> unresolved
```

For weighted scoring, use:

```text
resolvedScore = manualScore if present, else aiScore if present, else 0 with unresolved flag
indicatorWeightedScore = round2(resolvedScore * indicatorWeight)
dimensionScore = round2(sum(indicatorWeightedScore) / sum(indicatorWeight)) within the dimension
overallScore = round2(sum(resolvedScore * indicatorWeight * dimensionWeight) across all indicators)
```

For report explanations, an indicator's whole-project contribution can be shown as `resolvedScore * dimensionWeight * indicatorWeight`.

Scoring behavior by indicator type:

- Ratio or density indicators: extract numerator, denominator, computed value, and unit when the uploaded materials provide enough facts; then apply the threshold table.
- 条目累积法 indicators: count satisfied items explicitly; each satisfied item contributes 2 points, with a maximum of 10.
- Binary indicators: return 10 only when the uploaded materials state the item exists or is implemented; return 0 only when the materials clearly state it does not exist; otherwise return `scoreSuggestion: null` and `needsManualReview: true`.
- If material facts are absent, contradictory, or too weak, do not guess a score. Preserve the missing-evidence reason and flag manual review.

## Evidence Boundary

No separate evidence requirements are defined in this model snapshot. Use this evidence boundary:

- evidence must come from user-uploaded project materials;
- prefer `项目说明` and `项目调查报告`;
- use direct material facts for scoring;
- keep exact source snippets in `evidenceText`;
- set `source` to the uploaded document role or document name when available;
- mark manual review when the evidence is missing, contradictory, or too weak to judge.

## Report Use

When generating an evaluation report, include this model as the rubric section or appendix:

- model version: `V1.11 / 城市碳评估模型2`;
- dimensions and weights;
- enabled indicators, calculation methods, thresholds, and weights;
- score source for every indicator: manual score, AI score, or unresolved;
- evidence and confidence from uploaded project materials;
- unresolved/manual-review indicators;
- weighted contribution and benchmark gap where available.

Render PDF/DOCX/Markdown according to the user's requested output format and the report guidance in `evaluation-report-output.md`.
