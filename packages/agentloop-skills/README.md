# @zhujun/agentloop-skills

Bundled Skill packages shipped as a separate workspace package.

This package exposes the checked-in `skills/` directory and a helper for host
apps that want to consume the bundled catalog:

```ts
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
```

The kernel package `@zhujun/agentloop` no longer ships these assets directly.
