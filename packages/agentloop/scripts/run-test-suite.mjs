import { spawnSync } from "node:child_process";

const suites = Object.freeze({
  unit: [
    "tests/decision-binding.test.ts",
    "tests/decision-ledger.test.ts",
    "tests/evidence-gate-causality.test.ts",
    "tests/execution-context-policy.test.ts",
    "tests/practice-profiles.test.ts",
    "tests/process-artifacts.test.ts",
    "tests/step-execution-strategy.test.ts",
    "tests/terminal-log.test.ts",
    "tests/work-product-context.test.ts",
    "tests/work-product-observations.test.ts",
    "tests/work-product-semantics.test.ts",
    "tests/runtime-action-query-service.test.ts",
    "tests/runtime-conversation-working-set-query-service.test.ts",
    "tests/runtime-event-query-service.test.ts",
    "tests/runtime-host-run-projection-query-service.test.ts",
    "tests/runtime-plan-query-service.test.ts",
    "tests/runtime-workspace-service.test.ts",
  ],
  kernel: [
    "tests/batch.test.ts",
    "tests/concurrency.test.ts",
    "tests/content-reference-flow.test.ts",
    "tests/conversation-workspace.test.ts",
    "tests/cross-run-runtime-result.test.ts",
    "tests/human-loop.test.ts",
    "tests/kernel-boundary.test.ts",
    "tests/multi-agent.test.ts",
    "tests/planning-extension.test.ts",
    "tests/planner-capability-recovery.test.ts",
    "tests/planner-source-constraints.test.ts",
    "tests/recovery-transcript.test.ts",
    "tests/run-cancel.test.ts",
    "tests/run-service-language.test.ts",
    "tests/runtime-actions.test.ts",
    "tests/runtime-result-contract.test.ts",
    "tests/runtime-result-materializer.test.ts",
    "tests/step-execution-binding.test.ts",
    "tests/user-boundary-migration.test.ts",
  ],
});

const suite = process.argv[2];
const files = suite === undefined ? undefined : suites[suite];
if (files === undefined || process.argv.length !== 3) {
  console.error(`Usage: node scripts/run-test-suite.mjs <${Object.keys(suites).join("|")}>`);
  process.exit(2);
}

const result = spawnSync(process.execPath, ["--test", "--test-isolation=process", ...files], {
  stdio: "inherit",
});
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
