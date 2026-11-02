# AgentLoop Local Runtime

Shared device-local execution for embedded hosts. The package has no dependency
on an application directory, Router protocol, browser Session, device pairing or
cloud authentication service.

## Public entry points

| Import | Purpose |
| --- | --- |
| `@zhujun/agentloop-local-runtime` | Single Runtime facade and managed multi-Runtime lifecycle: conversations, Runs, ordered events, uploaded sources, artifacts and directory grants. Neither exposes SQLite, Supervisor or RunService handles. |
| `@zhujun/agentloop-local-runtime/connectors` | Shared Connector loader, registry, scoped resolver and Kernel tool projection. Concrete platform Connectors remain separately loaded modules. |
| `@zhujun/agentloop-local-runtime/host` | Trusted-host migration surface: shared Supervisor, model/Skill/MCP configuration stores, the legacy encrypted-file vault and low-level controls. New application business code should use the root facade. |

The host authenticates a caller and constructs `LocalExecutionContext`. Never
accept its `ownerUserId` directly from a browser request body. The Kernel still
enforces ownership when reading Runs, conversations, sources and artifacts.
Directory grants are Runtime-scoped; the host owns directory-picker consent.

```ts
import { createLocalRuntime } from "@zhujun/agentloop-local-runtime";

const runtime = await createLocalRuntime({
  id: "desktop-default",
  databasePath: "/absolute/application-data/runtime.db",
  workspaceRoot: "/absolute/application-data/workspace",
  uploadStorageRoot: "/absolute/application-data/uploads",
  skillPackageStoreRoot: "/absolute/application-data/skill-packages",
  models: provider, // LocalModelProviderPort: modelKeys() and create(key, onRetry)
});

const context = { ownerUserId: authenticatedLocalOwnerId };
const run = await runtime.startRun(context, {
  requestId: "stable-client-message-id", // Persist before sending; reuse on retry.
  input: "你好",
  modelKey: "local:my-model",
  allowDangerousTools: false,
});
// Poll getRun(context, run.id); resume events(context, run.id, lastSequence).
// Once accepted work has settled, await runtime.close().
```

Provider keys are qualified as `local:<key>`. “Local” means the provider is
configured by the host; the provider itself may call a remote model service.
The root facade rejects unknown selections before creating a conversation and
never silently selects a cloud proxy. Its initial web-search configuration is
disabled; configured MCP and Connector network calls remain explicit extensions.

Closing during Run admission or active execution is rejected. After the work
settles, close is idempotent. The embedding host owns process locks and must not
open the same writable database from two hosts at the same time.

## Managed application API

New hosts can use the same business facade with persisted Runtime management:

```ts
import { createLocalRuntimeManager } from "@zhujun/agentloop-local-runtime";

const manager = await createLocalRuntimeManager({
  dataDirectory: "/absolute/dedicated-desktop-data",
  defaultRuntimeId: stableInstallationRuntimeId,
  models: provider,
  maxConcurrentRuns: 10,
});
const runtimes = await manager.runtimes();
const runtime = manager.runtime(runtimes[0]!.id);
const models = await runtime.models();
const run = await runtime.startRun(context, {
  requestId: persistedClientMessageId,
  input: "你好",
  modelKey: userSelectedModelKey, // Chosen explicitly from the models catalog.
});
// After work settles: stopRuntime / startRuntime / restartRuntime / drainRuntime.
// configureRuntime configures Skill/MCP bindings; it does not install plugins.
// At application shutdown, after active calls and executions settle:
await manager.close();
```

Management and directory-consent calls require trusted host authorization. A
retained business view resolves the current control on every call and survives
restart; a stopped Runtime rejects business access. Historical reads while
stopped are not yet part of this view. The old host's separate Artifact read
plane remains host-owned. Async reads hold lifecycle leases, so stop/restart
cannot close their database mid-call. Leases do not count as active Runs.

The dedicated directory contains `supervisor.db`, `runtime.db`, `runtimes/`,
`uploads/`, `workspace/` and `skill-packages/`. Stable IDs are host-owned. This API
does not acquire a process lock or migrate an installed Agent's directory.

## Persisted model settings

Omit `models` to use the shared configuration store and supply a dedicated
`modelSecrets` vault. Explicit `models` injection takes precedence and makes the
persisted settings read-only; without a vault the settings are also read-only.

```ts
import { createLocalRuntimeManager, EncryptedLocalRuntimeSecretStore }
  from "@zhujun/agentloop-local-runtime";

const manager = await createLocalRuntimeManager({
  dataDirectory: "/absolute/dedicated-desktop-data",
  defaultRuntimeId: stableInstallationRuntimeId,
  modelSecrets: new EncryptedLocalRuntimeSecretStore(
    "/absolute/dedicated-desktop-data/private/model-secrets",
  ),
});
const settings = await manager.modelConfiguration(); // No API key readback.
await manager.configureModels({ reuseCloudModels: false, providers: [{
  key: "my-provider", displayName: "My provider", baseUrl: approvedProviderUrl,
  apiKey: locallyEnteredCredential,
  models: [{ key: "my-model", displayName: "My model",
    providerModel: upstreamModelName, protocol: "chat-completions" }],
}] }, settings.revision);
```

These are trusted-host management methods, not self-authenticating endpoints.
The host must authorize access, protect credential transport and restrict unsafe
endpoints (Desktop permits HTTP/HTTPS without URL credentials, queries or
fragments; plaintext HTTP exposes credentials and inference to the network).
The manager forbids cloud
model reuse; the legacy host store separately retains its explicit cloud policy.
Model parameters use the existing shared registry validation and adapters.

Writes are serialized and reject stale revisions. Model changes acquire the
device reconfiguration gate and refuse active Runs, pending admissions or
business leases; the Factory reads the published store without Runtime restart.
The same provider key and canonical endpoint may preserve a blank API key;
changing the endpoint requires a new credential. A failed database write leaves
the previous catalog/credential intact. Cleanup occurs after commit: failures
return `credentialCleanupPending` without restoring a possibly removed old
credential. This warning is process-local; no automatic cleanup tool is provided.

The exported file vault uses AES-256-GCM with a co-located file master key, not
Keychain/DPAPI. It cannot protect against same-user malware or theft of the full
directory. Missing master keys fail closed instead of recreating keys over
existing ciphertext. Keep model and MCP/Connector vaults separate. Saving a
configuration makes no provider request and is not a connectivity/compatibility
test. Remote provider inference sends content to the configured service.

## Durable Run admission

`requestId` is scoped by Runtime and authenticated owner. Identical retries,
including concurrent calls and reopen, return the original Run without a new
capacity slot. Changing business input for the same ID is a conflict. Omitting
Connector selection is different from explicitly selecting `[]`. Omitting the
request ID generates a fresh identity and does not deduplicate separate calls.

The local admission ledger reserves the ID before execution. Its binding is
written in the same Kernel database transaction as the Run, uploaded-source
bindings and directory bindings, before notifications or model execution. A
confirmed rollback releases the reservation; a committed binding survives a
lost response. The trusted `RunStartPersistence` hook is not a JSON execute
option and must not perform network/filesystem work.

An unbound reservation recovered after process loss returns
`admission_outcome_unknown`; it is never automatically retried. A persisted
`running` Run keeps capacity regardless of age and requires explicit Kernel
recovery/cancellation, not model replay. Conversation deletion atomically leaves
a tombstone: the original ID returns `admission_run_deleted` (410), never a new
Run. Unexpected missing, unmarked Runs remain explicit integrity errors.

This is Run-admission idempotency, **not** exactly-once execution of arbitrary
external effects. A status change to cancelled is also not proof that execution
has unwound; guarded close and drain wait for actual process-local execution.
Close refuses active calls/Runs, and a refused preflight leaves the manager
usable. Partial teardown failures remain fail-closed.

Memory is opt-in. Enabling it requires a selected `local:` settlement model and a
stable `LocalIdentityPort`; the existing
Local Agent adapter supplies its previously persisted default Runtime identity
to preserve the `local-device:<identity>` namespace. The Memory database registry
belongs to each Factory instance, so hosts cannot overwrite one another's entries.

The Connector loader preserves the existing trusted-host development behavior.
It is not a signed installer or process sandbox. Do not pass arbitrary browser
module paths to it; Desktop's approved plugin installation is a later stage.

## Shared host lifecycle and configuration

The existing Local Agent imports the Supervisor and configuration implementations
from `./host`; its old paths are compatibility exports, not separate copies.
Existing SQLite tables, Runtime IDs, MCP secret references and model snapshots
remain compatible. Cloud identity, Router traffic, concrete Connector OAuth and
platform UI are still application adapters.

Supervisor admissions count both in-flight starts and active Runs against the
per-Runtime capacity. Stop/drain/restart/remove own a Runtime mutation gate before
their first database await. Device reconfiguration excludes admissions and
Runtime mutations; a reload acquires this gate even when called directly. An
owning configuration transaction may reload and roll back within its own async
context without allowing another caller to reuse the gate. Successful recovery
updates both persisted lifecycle status and the advertisement cache.

The `./host` surface remains trusted low-level infrastructure, not an
authenticated UI API. The old strict-local and Router adapters now use the same
admission service, atomically preserving historical dispatch rows. They inject
the old host's explicit cloud-proxy model policy; the root facades remain
local-catalog-only. Legacy `Supervisor.close()` retains its unguarded teardown
semantics; new hosts should use the root manager's guarded close.

`EncryptedLocalRuntimeSecretStore` preserves the prior file format and is not an
OS Keychain implementation. The existing composition root keeps model secrets
in a separate vault from MCP/Connector secrets. When a vault is shared, its
composition root must supply all additional live references to configuration
cleanup; it must not let one store reclaim another owner's secrets.

## Build and verify

From the repository root, after installing the locked workspace dependencies:

```sh
npm run build:kernel
npm run build:skills
npm run build:memory
npm run build:connector-sdk
npm run build:local-runtime
npm run test:local-runtime
```

Execution tests use deterministic model responses with the real Kernel and
temporary SQLite/files, including the Supervisor → Factory → Kernel chain.
Lifecycle tests use stub controls with real SQLite to isolate concurrency,
capacity, configuration rollback and credential recovery. Admission tests inject
actual SQLite write failures and a post-commit lost response; process-loss and
interrupted-running cases are persisted-state fixtures, not actual process-kill
or external-tool crash acceptance. Deletion tests cover rollback and tombstones.
These are not live-model or desktop-installation acceptance.

The Desktop development launcher/Web/API and persisted model settings now use
these root APIs. Connector configuration migration, cloud authentication,
OS SecretStore, installers and real-provider acceptance remain subsequent work. See
[the implementation plan](../../docs/LOCAL-RUNTIME-AND-DESKTOP-APP-DESIGN.md).
