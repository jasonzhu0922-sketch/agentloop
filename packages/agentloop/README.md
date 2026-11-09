# @zhujun/agentloop (kernel)

Plan-first single-agent runtime kernel for professional AI agents. This package
is a **headless library**: it ships the planning/runtime/storage/tool
engine and exposes it through the `@zhujun/agentloop` entry point only.

- Identity is an opaque `userId` string; bring your own authentication.
- Persistence goes through injectable connections/stores (SQLite default).
- HTTP serving is not part of the kernel — see `apps/agentloop-desktop` for the Desktop host and
  `apps/agentloop-multi-runtime` for the multi-runtime application.
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
the Desktop App or bundled Skills. The host should install the generated
tarball (or the published `@zhujun/agentloop` package) and import only from the
package entry point:

```ts
import { AppDatabase, RunService, SkillService } from "@zhujun/agentloop";
```

The Desktop App is an independent local host. Its HTTP server, authentication,
and web UI are not part of the kernel delivery contract.

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

## Conversation reconstruction

`executeConversation` and `startConversation` resolve the latest request against
durable conversation history before admitting a new Plan. Original Run inputs
remain available even when a provider or planning failure prevented a Plan from
being created. Historical Plans and published Results remain immutable.

A prior-work binding rejection starts model-driven intent reconstruction within
the existing three-call resolution budget. The model receives chronological
requests, prior constraints, Plan step states, failure boundaries, and published
Result/artifact candidates. It reconstructs the latest goal and output contract;
the ordinary Planner then creates a new Plan with validated input bindings.
Selecting a Result can supply its producer identity without a duplicate goal
selector. Changing delivery preserves that Result's historical time scope, while
an explicit source refresh uses the new Run clock. Execution reads full bound
Results through `read_result`, rather than treating history summaries as complete.

Reconstruction emits `conversation.turn.reconstruction_started`, followed by
`reconstruction_completed` or `reconstruction_unresolved` under the same event
prefix. An unresolved historical target becomes a tool-free clarification; it
does not authorize arbitrary prior results or suppress unrelated schema errors.
History and Plan projections disclose their bounded coverage. This mechanism
does not imply that every historical Run is present in the current context.

## Build & test

```sh
npm run build   # tsc -> dist/ (the published artifact)
npm test        # stable Unit + SQLite Kernel contracts
npm run test:unit
npm run test:kernel
npm run test:full # extended suite; includes environment-dependent coverage
```
