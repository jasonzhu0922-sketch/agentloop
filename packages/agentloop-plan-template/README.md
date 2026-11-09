# @zhujun/agentloop-plan-template

Optional AgentLoop planning extension package for Plan Template fast-path experiments.

The package owns its storage connection, schema migration, matching, and lifecycle logic. Host applications should treat its options as opaque data: app config decides whether the plugin is bound and where it is discovered from, then passes final options to `createPlanTemplatePlugin`.

A host can supply plugin defaults through `optionsPath` and override them with app-level `options` before calling the factory.

## Offline mining

The first miner implementation only creates `candidate` templates. It never promotes a template to `active`; approve candidates explicitly through the management API or CLI.

```bash
npm run mine --workspace @zhujun/agentloop-plan-template -- --config /path/to/plan-template.defaults.json
npm run templates --workspace @zhujun/agentloop-plan-template -- list --config /path/to/plan-template.defaults.json --status candidate
npm run templates --workspace @zhujun/agentloop-plan-template -- approve --config /path/to/plan-template.defaults.json --id template_xxx
```
