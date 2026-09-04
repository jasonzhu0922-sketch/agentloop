# Plan Template 操作手册

这份文档只放常用运维命令：

- 查看最新 10 条 `observed`
- 执行 `mine`
- 查看候选模板
- 查看在用模板

默认示例使用参考应用的本地 SQLite 库：

```bash
/Users/zhujun/coding/agentloop/apps/agentloop-app/data/agentloop-plan-template.db
```

如果你实际使用的是 PostgreSQL，把下面的 `sqlite3` 查询替换成对应数据库客户端即可。

## 1. 查看最新 10 条 observe 结果

`observe` 结果保存在 `plan_template_matches` 表里，`decision = 'observed'`。

```bash
sqlite3 -header -column /Users/zhujun/coding/agentloop/apps/agentloop-app/data/agentloop-plan-template.db "
select
  id,
  run_id,
  template_id,
  decision,
  score,
  outcome_status,
  created_at
from plan_template_matches
where decision = 'observed'
order by datetime(created_at) desc
limit 10;
"
```

## 2. 执行 mine

```bash
npm run mine --workspace @zhujun/agentloop-plan-template -- --config apps/agentloop-app/config/plan-template.defaults.json
```

这条命令会扫描 `observed` 记录，尝试生成或更新候选模板。

## 2.1 查看 mine 聚类簇

下面这条按矿工实际使用的可观察字段，把 `observed` + `completed` + `canonical completed outcome` 的样本分簇，方便看为什么只更新了旧模板、或者为什么某个簇还没到 3 条。它不是内部 `shapeKey` 的字节级复刻，但足够做运维排查。

```bash
sqlite3 -header -column /Users/zhujun/coding/agentloop/apps/agentloop-app/data/agentloop-plan-template.db "
select
  json_extract(task_fingerprint_json, '$.intentHints[0]') as intent_family,
  json_extract(task_fingerprint_json, '$.sourceNeed') as source_need,
  json_extract(task_fingerprint_json, '$.artifactKind') as artifact_kind,
  json_extract(task_fingerprint_json, '$.sideEffectKind') as side_effect_kind,
  coalesce(json_extract(admission_result_json, '$.proposal.shape'), 'unknown') as plan_shape,
  json_array_length(json_extract(admission_result_json, '$.proposal.selectedSkillIds')) as selected_skills,
  json_array_length(json_extract(admission_result_json, '$.proposal.steps')) as steps,
  count(*) as n,
  group_concat(run_id, ', ') as run_ids
from plan_template_matches
where decision = 'observed'
  and outcome_status = 'completed'
  and admission_result_json is not null
  and json_extract(admission_result_json, '$.outcome.reasonCode') = 'plan_assessed_and_completed'
group by 1, 2, 3, 4, 5, 6, 7
order by n desc, intent_family, source_need, artifact_kind, side_effect_kind, plan_shape;
"
```

只看已经达到候选门槛的簇：

```bash
sqlite3 -header -column /Users/zhujun/coding/agentloop/apps/agentloop-app/data/agentloop-plan-template.db "
select
  json_extract(task_fingerprint_json, '$.intentHints[0]') as intent_family,
  json_extract(task_fingerprint_json, '$.sourceNeed') as source_need,
  json_extract(task_fingerprint_json, '$.artifactKind') as artifact_kind,
  json_extract(task_fingerprint_json, '$.sideEffectKind') as side_effect_kind,
  coalesce(json_extract(admission_result_json, '$.proposal.shape'), 'unknown') as plan_shape,
  json_array_length(json_extract(admission_result_json, '$.proposal.selectedSkillIds')) as selected_skills,
  json_array_length(json_extract(admission_result_json, '$.proposal.steps')) as steps,
  count(*) as n,
  group_concat(run_id, ', ') as run_ids
from plan_template_matches
where decision = 'observed'
  and outcome_status = 'completed'
  and admission_result_json is not null
  and json_extract(admission_result_json, '$.outcome.reasonCode') = 'plan_assessed_and_completed'
group by 1, 2, 3, 4, 5, 6, 7
having count(*) >= 3
order by n desc, intent_family, source_need, artifact_kind, side_effect_kind, plan_shape;
"
```

## 3. 查看候选 Template

```bash
npm run templates --workspace @zhujun/agentloop-plan-template -- list --config apps/agentloop-app/config/plan-template.defaults.json --status candidate
```

## 4. 查看在用 Template

在这个实现里，“在用”通常指 `active` 模板。

```bash
npm run templates --workspace @zhujun/agentloop-plan-template -- list --config apps/agentloop-app/config/plan-template.defaults.json --status active
```

## 5. 查看某个 Template 详情

```bash
npm run templates --workspace @zhujun/agentloop-plan-template -- show --config apps/agentloop-app/config/plan-template.defaults.json --id template_xxx
```

## 6. 批准候选 Template

```bash
npm run templates --workspace @zhujun/agentloop-plan-template -- approve --config apps/agentloop-app/config/plan-template.defaults.json --id template_xxx
```

## 7. 废弃 Template

```bash
npm run templates --workspace @zhujun/agentloop-plan-template -- retire --config apps/agentloop-app/config/plan-template.defaults.json --id template_xxx
```

## 8. 常见判断

- `observed` 为空，先确认插件是否启用了 `observeEnabled`
- `mine` 没有新候选，通常是因为缺少 `canonical_completed_outcome`
- `candidate` 有结果但没在运行时生效，检查模板是否已 `active`
- `active` 有结果但路由没命中，检查 `mode`、`allowDirectUse` 和匹配分数阈值
