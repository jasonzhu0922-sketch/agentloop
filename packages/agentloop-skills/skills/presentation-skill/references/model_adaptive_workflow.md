# Model-Adaptive Workflow

Use this reference when choosing how much planning, delegation, and QA a deck
needs. The renderer and source contracts stay the same across model variants;
only the amount of model-side orchestration changes.

## Core rule

Keep the active prompt small. Store reproducibility detail in workspace files
and reports, then expose only the decisions needed for the current phase.

- Start from `agent_brief.md` or `agent_brief.json`.
- Read `deck_start_packet.json` only for recovery, audit, or a missing command.
- Load one style reference, schema section, or QA report at a time.
- Do not paste the corpus, full preset catalog, or full replay ledger into a
  model prompt.
- Preserve required facts, decisions, caveats, and next actions. Remove
  repeated process language before removing required content.

This follows current GPT-5.6 guidance: use shorter prompts, define autonomy
once, give lightweight task structure, and evaluate the final artifact rather
than rewarding extra calls or copied intermediate state.

## Execution profiles

### Quality-first

Aliases: `frontier`, `sol`, `pro`.

Use for high-stakes scientific, clinical, board, investor, regulatory, or
public-release decks; difficult source synthesis; or decks with complex data
artifacts.

- Main agent owns the deck and source edits.
- One design/content scout may return bounded decisions.
- One data scout may be used when local data or computed evidence is material.
- Run rendered visual review and inspect slide images at original detail.
- Iterate until source, rendering, readability, and delivery gates pass.

### Balanced

Aliases: `terra`, `standard`.

Use for most professional decks.

- Main agent selects the style route and authors source files.
- Use at most one scout when style, evidence, or asset selection is genuinely
  ambiguous.
- Run deterministic QA plus rendered visual review.
- Prefer one focused repair loop over repeated planning passes.

### Fast

Aliases: `luna`, `draft`.

Use for short drafts, internal working decks, and high-volume generation.

- Use deterministic routing and existing renderer recipes.
- Avoid scouts unless missing data or assets block the deck.
- Build once with render-free QA, then render the final candidate.
- Escalate to `balanced` if visual or readability warnings remain.

### Auto

`auto` chooses `quality-first` for high-stakes or evidence-heavy requests,
`fast` for explicit rough/quick drafts, and `balanced` otherwise. The user or
calling harness may always override the profile.

## Phase-sized context

### Plan

Give the model:

- the user request;
- the compact question answers or assumptions;
- one primary style route and at most two secondary influences;
- the evidence/asset burden;
- the required output paths and completion gates.

Do not give it every corpus record, every preset, or the full QA manual.

### Author

Give the model:

- current `outline.json` and the relevant planning-file summaries;
- selected renderer treatments and supported variants;
- generated artifact aliases, if any;
- readable type and density constraints.

The model should write topic-specific slides directly. It should not copy
replay ledgers, recipe signatures, or command ladders into its answer.

### Repair

Give the model:

- the rendered slide image or contact sheet;
- exact slide IDs and measured warnings;
- the source files and fields to edit.

The repair pass should change source, rebuild, and rerun only the affected
checks before the final full gate.

## Stable backbone

All profiles preserve the same backbone:

1. Source files and data/figure scripts are authoritative.
2. The PPTX remains editable.
3. Style routing influences composition, not only palette.
4. Charts, tables, and figures carry source and rebuild metadata.
5. Geometry, visual inspection, placeholder checks, and delivery readiness
   gate final output.

The profile changes model effort and context exposure, not the quality
definition of a finished deck.
