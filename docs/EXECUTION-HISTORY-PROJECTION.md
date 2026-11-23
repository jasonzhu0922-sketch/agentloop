# Execution history projection

The execution context uses `agentloop.executionHistory/v2`. `ContextPolicy.executionHistoryProjection` defaults to `current`; `canonical` is the controlled comparison setting. This changes model input only. Canonical assistant content, tool arguments, receipts, events and model responses remain intact.

## Ownership and information preservation

- `ContextAssembler` projects history before budget estimation on ordinary and completion-repair turns. The actual request and its token estimate use the same history payload.
- Assistant text accompanying a complete tool exchange is retained verbatim, with source ToolCall IDs, in a labelled Runtime context section. Its native assistant message retains calls and opaque provider reasoning, with no historical prose in its content. Statements are explicitly unverified unless supported by current evidence. No linguistic heuristic decides whether prose is a promise, hypothesis or expendable narration.
- `CurrentDecisionView.identity` and the registered tool effects are checkpoint provenance on `assistant.committed`. They are not a new fact database. Recovery reads these original checkpoints; legacy checkpoints without the metadata are not eligible for failure folding.
- User messages, including Steer/HIL resolutions already materialized in the transcript, survive whole-exchange compaction verbatim. An input containing only protected user text is not sent to a compactor merely to obtain a shorter answer. If protected input exceeds the window, the runtime fails the budget instead of silently dropping constraints.
- Existing structured compaction receives the history records and complete error text. Its summary remains an interpretation, not execution authority. Assistant judgments outside the retained tail still depend on the existing summarizer's preservation contract; this change does not prove arbitrary lossless semantic summarization.

## Failure equivalence

Only adjacent, closed batches of registered **read** tools with explicitly completed invocations and failed operation outcomes can fold. The full historical decision identity, declared effects, ordered tool names and arguments, complete result content, invocation/operation status, failure phase and exit status must match. Reasoning-bearing exchanges are not folded.

A validated outer `ResultRef` publication ID may differ because each publication has a new identity. Source ResultRefs, source versions and the entire remaining result content still participate in equality. The latest native call and full receipt remain. The history record contains every attempted ToolCall ID, result digest, Run ID, event types and batch attempt count. Parallel receipt digests are aligned by ToolCall ID, independently of return order.

User turns, new parameters, changed state/plan versions, different evidence, success, mixed successful/failed batches, writes and unknown outcomes stop folding. Unknown tool-effect metadata also stops folding. This is intentionally conservative: real traces with changing audit identities or throwing tools can have **zero merges**. No error-code, SQL, model-provider or application-specific branch relaxes this boundary.

## Protocol and recovery

Native calls and results are retained or folded together. Incomplete live exchanges are rejected before model dispatch. When no tools are exposed, the shared prompt encoder transports historical statements and complete attempted calls as labelled non-executable evidence; it no longer drops the entire assistant turn.

Recovery retains completed siblings from interrupted batches, including successful writes. Missing siblings remain `unfinishedToolCalls`; no synthetic successful receipt is created. The same protection applies to early-dispatched calls whose full assistant checkpoint was never committed. Existing Run/action recovery remains responsible for resolving uncertain effects before execution resumes.

## Verification and limitations

The task's complete evidence bundle is under `outputs/context-projection-audit/`. This directory contains provider requests and responses, gateway correlation IDs, every successful/failed/limited sample, build/test logs, application replay events and source/package hashes. It is local audit material, not a checked-in production benchmark.

- `npm run build`: passed.
- `npm run test:full`: 1,231 passed, 17 failed, 2 skipped. All 17 failure names match the pre-change unrestricted baseline (1,197 passed, 17 failed, 2 skipped); zero new failures. Existing failures cover planner assertions, artifact state expectations, filesystem/Skill fixtures, a migration assertion, PostgreSQL test setup and workflow fixtures. The complete suite is **not green**.
- Focused projection/protocol/recovery/application-boundary coverage: 215 tests passed before two additional execution-loop behavior tests; the projection suite including both new behavior tests passes 34 tests. Tests check corrected executed parameters, no repeated recovered write, full evidence, exact user constraints, version boundaries, parallel provenance, incomplete calls, deterministic repeated projection and compression/recovery composition.
- Wire capture covers Chat Completions and Responses, `complete` and `streamComplete`, and the OpenAI-compatible, OpenAI, DeepSeek and Alibaba SDK paths. Provider-specific continuation follows the existing adapter protocol. Live A/B uses the configured Chat Completions gateway; wire mocks are not live deployment acceptance for every provider.
- A sanitized **real non-Data-Agent** fixture comes from persisted public-standards research events: two distinct parallel search requests failed on quota, followed by fetched pages that were missing or irrelevant to the requested standard. The test preserves those limitations instead of treating successful HTTP transport as task success.

### Interleaved live A/B

Five pairs each for short tasks, long-history recovery and detailed delivery; AB/BA ordering alternates. Model, temperature, output limit, system/user text and simulated read-tool data are fixed. Only `executionHistoryProjection` changes. **Mixed routing, upstream identity unknown**; no H20/domestic-deployment attribution is made.

| Scenario / strategy | Reviewed delivery | Correct tool arguments | Mean process characters | Mean input / output tokens | Mean total seconds |
| --- | --- | --- | --- | --- | --- |
| Short / canonical | 5/5 | 5/5 | 35.6 | 1,226 / 263 | 6.97 |
| Short / current | 5/5 | 5/5 | 43.2 | 1,513.4 / 266.2 | 10.48 |
| Long recovery / canonical | 0/5 | 0/25 | 5,975 | 15,379 / 1,322.4 | 28.66 |
| Long recovery / current | 5/5 | 5/5 | 0 | 3,539 / 261.6 | 8.09 |
| Detailed / canonical | 5/5 | 5/5 | 47.2 | 1,259.4 / 918 | 14.85 |
| Detailed / current | 5/5 | 5/5 | 54.4 | 1,543.4 / 854.4 | 17.07 |

The canonical long-history samples all hit the five-turn limit; their time is **time to failure**, not comparable successful completion latency. Short and detailed tasks have more input overhead and higher observed latency with the new strategy. This is evidence for recovery correctness in the controlled fixture, not a general speed improvement.

Detailed reports preserve the required rows, units, date, source, arithmetic and missing-data/trend caveats. A manual review still flags unqualified completeness wording in one baseline and two current reports. Coverage success does not establish flawless factual phrasing. One baseline arithmetic regex false negative was corrected in `summary.json` after reviewing the equivalent labelled formula; the raw `results.json` was not rewritten.

The first experimental strategy (`v1`) left labelled history in assistant content. One real sample copied that JSON and repeated a successful read; another sample timed out. Those records remain under `live-network/`. The final strategy moves the records to server context. The final parallel-provenance correction was revalidated against **all 75 saved v2 model requests**: projected messages and history payloads are identical for these single-call samples. Source hashes and the comparison are in `summary.json`.

### Application boundary

The standalone Data Agent receives a rebuilt `vendor/zhujun-agentloop-0.1.0.tgz` through npm, with the lockfile integrity updated. No `node_modules` source edit or application history patch is used. Its application tests (47), typecheck, TiDB integration test, Python gateway suite (144, 11 skipped) and catalog suite (44) pass.

The original same-question input is “鄂钢2022年12月31日的铁水成本”. Replays use isolated Runtime audit databases because the existing database has a live host lease; business configuration and model settings remain unchanged. Run results, source-query failures, model-stream failures and actual projection-policy events are recorded in `app-replay*.json`. A failed replay never counts as acceleration or production acceptance. See the delivery report in the evidence directory for final replay outcomes and package hashes.
