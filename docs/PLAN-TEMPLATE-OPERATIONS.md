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

