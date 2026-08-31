# @zhujun/agentloop (kernel)

Plan-first single-agent runtime kernel for professional AI agents. This package
is a **headless library**: it ships the planning/runtime/storage/tool
engine and exposes it through the `@zhujun/agentloop` entry point only.

- Identity is an opaque `userId` string; bring your own authentication.
- Persistence goes through injectable connections/stores (SQLite default).
- HTTP serving is not part of the kernel — see `apps/agentloop-app` for the
  reference application (HTTP API + auth + web frontend).
- Bundled Skills live in `@zhujun/agentloop-skills`.

## Delivery to baowu-super-agent

Only this directory is the integration artifact. Build and pack it with:

```sh
npm run pack:kernel
```

Bundled Skills are packaged separately with:

```sh
npm run pack:skills
```

The generated package contains the compiled kernel only; it does not contain
`apps/agentloop-app` or bundled Skills. The host should install the generated
tarball (or the published `@zhujun/agentloop` package) and import only from the
package entry point:

```ts
import { AppDatabase, RunService, SkillService } from "@zhujun/agentloop";
```

`apps/agentloop-app` is a reference application for local demonstration and
acceptance. Its HTTP server, authentication, and web UI are not part of the
kernel delivery contract.

## Usage

```ts
import {
  AppDatabase,
  LlmProviderRegistry,
  RunService,
  SkillService,
} from "@zhujun/agentloop";

const database = new AppDatabase("./data/app.db");
const skills = new SkillService(database, { skillDirectories: ["./custom-skills"] });
const providers = await LlmProviderRegistry.fromConfigFile("./llm-providers.json");
const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, modelKey) => providers.create(modelKey, onRetry),
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot: "./workspace",
});
```

## Build & test

```sh
npm run build   # tsc -> dist/ (the published artifact)
npm test        # node:test suite in tests/
```
