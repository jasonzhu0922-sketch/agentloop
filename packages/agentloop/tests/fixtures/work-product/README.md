# Stage 0 work-product replay fixtures

These are minimized, anonymized extracts, not full Run exports or claims of successful recovery.
Normal tests read only these checked-in files. They require no production DB, network, model provider,
workspace artifacts or installed Office tools. All replayed tool bodies return in-memory JSON;
they do not execute the recorded commands.

## Provenance

- A: `b564c522-6372-4f35-bf77-6b3a7dd597cd`, tool event seq 761/820/860/910.
- B: `d0e99198-4811-4c89-a576-1b9d92da5322`, tool event seq 821/858/886/913/1018/1063/1159/1185/1217.
- Each also preserves the last four empty `model.request.completed` responses with original seq.
- `originalPayloadSha256` hashes the unmodified persisted `run_events.payload_json`.
  The 21 selected original payload hashes were verified using a read-only DB connection.
- Tool call IDs, operation statuses, exit codes, file change types, byte counts and available
  original content hashes are preserved. Two business filenames become `themed.pptx` and
  `generator.js`/`generator.cjs`; machine-specific absolute prefixes become `/workspace/` or `/repo/`.
- File contents/inspection excerpts are omitted; stdout/stderr are redacted and capped at 600 characters.
  Original stream refs still describe the ORIGINAL bytes, not these previews. Tests never dereference them.
- The reducer's `source.resultSha256` hashes the supplied minimized result. It is deliberately distinct
  from both the original payload hash and artifact/content-stream hashes.

`work-product-replay.test.ts` characterizes the current consumer's deletion/failed-result defects and
replays selected tool results followed by empty completions through the real agent loop. Assessment
is scripted to reject and then reuse the rejection. It does not replay the entire Plan, provider,
Recovery or terminal chain. This boundary must remain explicit when interpreting green tests.

Synthetic C–F and edge cases live in `work-product-observations.test.ts`: failed command with partial
files, versions/deletion, long unrelated history, conversation/source controls, scoped checks and conflicts.
They are deliberately not attributed to the historical Runs.

## Repeat locally

```sh
node --test --test-isolation=process packages/agentloop/tests/work-product-observations.test.ts packages/agentloop/tests/work-product-replay.test.ts
npm run build:kernel
```

`baseline.json` records the pre-change commit, dirty file fingerprints and test results. Its known
failure names are documentation, not a test allowlist: the broader suite still exits nonzero. A disk
build hash is not evidence of the code loaded in a running Host. No Host was restarted for this phase.
