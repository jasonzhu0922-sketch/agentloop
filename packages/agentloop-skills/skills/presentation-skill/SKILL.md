---
name: presentation-skill
description: "Build, edit, redesign, render, and verify polished editable PowerPoint `.pptx` decks from a prompt, structured `outline.json`, local data, or a saved workspace. Use for presentation and slide-deck generation, lab/clinical/scientific reports, board and investor decks, editorial briefs, charts/tables/figures, template-inspired redesign, geometry/readability QA, rendered visual review, and reproducible deck workspaces. Aliases: PowerPoint skill, PPTX skill, presentation generator, slide-deck generator, deck builder, powerpoint-deck-builder, pptx-skill."
agentloop:
  roles:
    - primary_builder
  artifactKinds:
    - presentation
  sourceKinds: []
  qaKinds: []
---

# Presentation Skill

Create editable PowerPoint decks from source files. The model owns narrative,
evidence, and design judgment; repository scripts own deterministic rendering,
staging, and QA.

## Backbone

- Treat `outline.json`, planning files, local data, and figure scripts as the
  source of truth.
- Build with repository scripts. Do not write one-off inline `python-pptx` or
  `pptxgenjs` deck code.
- Fix source and rebuild. Do not patch generated `.pptx` files when source is
  available.
- Keep charts, tables, text, and layout objects editable where practical.
- Run build and artifact-acceptance checks before delivering a deck. Run QA and
  rendered visual inspection when the user asks for polish, a delivery rubric
  requires it, or a concrete diagnostic needs repair; do not turn warning-only
  QA into a blocking gate by default.
- Never install dependencies during a deck task. Report a missing dependency.
- Scaffold a new topic from its own evidence and story. Do not clone another
  deck's slide sequence as a house style.

## Start Here

Choose the workflow before reading references. Do not treat documentation
discovery as an authoring phase.

## AgentLoop Path Rule

When running package scripts through AgentLoop, use
`computer_run_command.cwd="@skills/presentation-skill"` only as the read-only
script root. Every task file path passed as `--workspace`, `--output`,
`--outdir`, `--input`, `--outline`, or similar arguments must be an absolute
path under the current `execution_context.workspace.root` value. In examples,
replace `/ABSOLUTE/RUNTIME/WORKSPACE` with that runtime workspace root before
running the command. Do not run examples with bare writable paths such as
`decks/my-deck`, `outline.json`, `out.pptx`, `renders`, or `review` while cwd
is `@skills/presentation-skill`; those paths resolve inside the read-only Skill
package and can trigger `SKILL_PACKAGE_MUTATED`.

### New Saved Workspace

For a new editable deck, use this bounded path. It is the default when the
user asks for a new `.pptx` and no existing deck source is supplied:

1. Initialize the workspace immediately with `init_deck_workspace.py`. Do not
   preload `DESIGN.md`, the full outline schema, a preset catalog, or workspace
   documentation before this command.
2. Read only the generated `agent_brief.md`. It is the authoritative compact
   brief for the active profile, selected style route, build commands, and
   delivery rubric. If an earlier Plan leaf already gathered sources, use its
   persisted evidence and do not repeat that research.
   If a readiness report says `record_deck_intake_answers`, run its displayed
   registered command once to persist best-judgment assumptions; do not search
   intake schemas or reference files.
3. In the next authoring turn, write the topic-specific source files and
   `outline.json`. Replace the starter content directly; do not list, search,
   or read every scaffold and reference file first. A single tool turn may
   write the planning files and outline in parallel.
4. Validate the outline, then build and run the requested QA. Repair only an
   actual validation, build, render, or QA failure.
5. Verify the generated `.pptx` and submit the delivery evidence.

The initialized brief already selects the page system and a bounded variant
mix. Use standard, title, comparison, chart, flow, table, stats, or
scientific-figure slides as the argument requires; keep the JSON source small
and let the validator identify an invalid field. Read one exact reference
section only after a validator or build diagnostic identifies an unknown field
or renderer contract. Do not perform schema/catalog discovery by listing,
searching, and reading multiple references.

This route must normally fit the sequence: initialize, brief, author, validate,
build, inspect, deliver. Do not spend the execution budget restating the
workflow or inspecting starter placeholders.

### Existing Sources And Specialized Work

Read only the context needed for the selected phase:

- `DESIGN.md` for the compact design contract when no generated brief exists.
- `references/outline_schema.md` only for a diagnosed source-field question.
- `references/model_adaptive_workflow.md` only when changing a profile or
  regenerating a brief.

- Saved/rebuildable deck: `references/deck_workspace_mode.md`
- Existing PPTX edit: `references/editing.md`
- Data/figure workflow: `references/reproducible_workflow.md`
- Style inspiration or screenshot/template matching:
  `references/style_reference_catalog.md`
- Structural diversity or topic-to-grammar routing:
  `references/composition_grammar_catalog.md`
- PptxGenJS renderer changes: `references/pptxgenjs.md`
- Fresh-eyes rendered QA: `references/visual_qa_prompt.md`

Open at most one task-specific reference on demand. Do not preload the corpus,
all preset descriptions, or every workflow reference.

### Existing Outline Redesign

When the user asks to improve, restyle, or reduce text in a deck that already
has a valid `outline.json`, take the source-first redesign route:

1. Read the current outline and the existing QA/design report. Read at most one
   additional reference only when a required field or the selected visual
   grammar is still unknown.
2. Choose the visual grammar and the small set of slide variants before writing.
   Do not repeatedly search the schema, preset catalog, or examples once that
   decision is made.
3. Update the outline as the single source of truth. Preserve factual content
   unless the user asks to change it; replace repetitive bullets with supported
   visual structures, concise labels, and editable data objects.
4. Write the revised outline under a new workspace-relative name, then validate
   its JSON before attempting a PPTX build:

   ```bash
   node scripts/validate_outline_json.js --outline /workspace/path/to/outline_redesigned.json
   ```

   Run repository scripts from the runtime-provided `@skills/presentation-skill`
   command root. Pass an in-bounds workspace source or output location only as
   a command argument; never put an absolute filesystem path in `cwd`.
5. If validation reports a parse error, repair the source file directly and
   rerun this validation. Do not spend further turns searching reference files
   to diagnose quotes, commas, brackets, or other serialization errors.
6. Only after the outline validates, build once, run the relevant QA, and record
   the final artifact acceptance evidence.

This route is deliberately bounded: read once, redesign once, validate once,
build once, and repair only after a real validation or QA failure.

## Model-Adaptive Route

Use workload profiles as orchestration controls, not as different quality
definitions:

- `quality-first` (`sol`, `frontier`, `pro`): difficult/high-stakes decks,
  complex evidence, full rendered review, optional bounded scouts.
- `balanced` (`terra`, `standard`): default professional route, at most one
  useful scout, one focused render/repair loop.
- `fast` (`luna`, `draft`): short internal drafts, deterministic routing,
  render-free first pass, then one final render.
- `auto`: choose from the request; high-stakes or evidence-heavy work becomes
  quality-first, explicit rough drafts become fast, everything else balanced.

The profile changes context and delegation, not the editable source contract or
final QA bar. Future models should use the smallest prompt that passes real
deck evaluations; do not add model-specific process prose without evidence.

For a new saved workspace, emit a compact brief automatically:

```bash
python3 scripts/init_deck_workspace.py \
  --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck \
  --title "My Deck" \
  --style-preset executive-clinical \
  --user-prompt "Original request" \
  --agent-profile auto
```

Follow the bounded new-workspace path above after initialization. Read
`agent_brief.md` first; it contains the active profile, style route, commands,
and completion rubric. Keep `deck_start_packet.json` on disk for audit/recovery;
do not paste it into the active model prompt or reopen the workflow references
unless a real diagnostic requires them.

To regenerate only the brief:

```bash
python3 scripts/model_adaptive_workflow.py \
  --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck \
  --packet /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck/deck_start_packet.json \
  --agent-profile auto
```

## Choose The Workflow

### Quick Deck

Use for a one-off 5-10 slide deck when no future rebuild workspace is needed.
Author `outline.json`, then:

```bash
node scripts/build_deck_pptxgenjs.js \
  --outline /ABSOLUTE/RUNTIME/WORKSPACE/outline.json \
  --output /ABSOLUTE/RUNTIME/WORKSPACE/out.pptx \
  --style-preset <preset>

python3 scripts/qa_gate.py \
  --input /ABSOLUTE/RUNTIME/WORKSPACE/out.pptx \
  --outdir /ABSOLUTE/RUNTIME/WORKSPACE/pptx-qa \
  --style-preset <preset> \
  --strict-geometry \
  --skip-render \
  --fail-on-design-warnings
```

### Saved Workspace

Use when the deck will be rebuilt, audited, or iterated. Author or update:

- `design_brief.json`: audience, style, readability, QA, and artifact rules
- `content_plan.json`: thesis, narrative arc, and slide roles
- `evidence_plan.json`: claims, sources, and chart candidates
- `asset_plan.json`: images, charts, tables, icons, and generated assets
- `outline.json`: renderable slide source
- `notes.md`: assumptions and unresolved details

Before rendering a resumed workspace:

```bash
python3 scripts/report_workspace_readiness.py --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck
```

Build a fast source-first pass:

```bash
python3 scripts/build_workspace.py \
  --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck \
  --qa \
  --skip-render \
  --overwrite
```

Build the final rendered candidate:

```bash
python3 scripts/build_workspace.py \
  --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck \
  --qa \
  --visual-review \
  --overwrite
```

Use strict warning gates only when the user, current Plan evidence contract, or
delivery rubric explicitly requires warning-free QA evidence:

```bash
python3 scripts/build_workspace.py \
  --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck \
  --qa \
  --fail-on-planning-warnings \
  --fail-on-whitespace-warnings \
  --overwrite
```

Finish with:

```bash
python3 scripts/report_delivery_readiness.py --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck
```

### Existing PPTX

When source files exist, edit them. For a standalone PPTX with no source,
inspect before choosing a route:

```bash
python3 scripts/inventory.py input.pptx
python3 scripts/extract_outline.py input.pptx --output extracted-outline.json
```

Use `scripts/edit_deck.py` for narrow text/slide edits. Use
`scripts/extract_pptx_style.py` plus a fresh workspace when the user wants a
source-first redesign inspired by an existing deck.

## Design And Taste

Choose one primary visual grammar from the audience, content structure, and
evidence burden. Presets are starting points, not templates to reproduce
unchanged.

Use the style corpus as retrieval memory:

- Route by topic, audience, evidence shape, density, and narrative arc.
- Select one primary reference and at most two bounded secondary influences.
- Convert descriptors into supported renderer fields and topic-specific
  compositions.
- Never copy proprietary slides, logos, text, or distinctive geometry.
- Record public-source rights posture when adding reusable inspiration.

For non-trivial decks, resolve a composition grammar before outline authoring:

```bash
python3 scripts/composition_grammar_catalog.py \
  --topic "Deck topic" \
  --user-prompt "Original request" \
  --style-preset <preset>
```

The catalog exposes eight first-class grammars: Answer Pyramid, Evidence
Plate, Care Pathway, Editorial Spread, Thesis Stage, Operating Grid, Public
Docket, and Telemetry Canvas. Each grammar owns role systems for title,
section, evidence, comparison, data, decision, and references plus a narrative
arc, grid, density, reading path, invariants, and forbidden moves. Normal
workspace initialization stores the matching `renderer_role_contracts_v2`
inside the style execution plan and planning files. The v2 contract gives
title, section, evidence, comparison, chart, table, decision, and references
their own normalized semantic slots and fallback. Slides may request only the
bounded `role_layout_variant` values `primary`, `alternate`, or `dense`; do not
invent coordinates in `outline.json`.

Archived workspaces that contain only `renderer_role_systems_v1` remain pinned
to v1. Upgrade one explicitly and idempotently with:

```bash
python3 scripts/upgrade_renderer_role_contracts_v2.py \
  --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck
```

Keep the primary grammar's frame, navigation, and reading path coherent. The
model may choose topic-fit variants and borrow at most two bounded treatment
moves, but it must not merge complete role systems from unrelated grammars.

When style families appear too similar, run the controlled gate. It renders
role-complete identical content through every preset, extracts paint-neutral
semantic geometry, and clusters title, section, evidence, comparison, chart,
table, decision, references, and dense-content stress slides independently.
Every role must produce at least eight clusters across the 13 presets, no
cluster may exceed two presets, normalized entropy must be at least `0.78`,
and cross-grammar clusters fail:

```bash
python3 scripts/run_controlled_style_diversity_smoke.py --render \
  --outdir /ABSOLUTE/RUNTIME/WORKSPACE/presentation-skill-controlled-diversity
```

Preset-owned page systems create structural identity at thumbnail scale:

- `clinical-rail`
- `board-ledger`
- `editorial-field`
- `command-canvas`
- `lab-plate`
- `investor-thesis`

The model may mix body treatments while keeping one page system coherent.
Useful composition controls include:

- `image_sidebar_mode`: `analysis-rail`, `evidence-mosaic`, or
  `editorial-atlas`
- `comparison_mode`: `open-columns` or `scorecard`
- `chart_treatment`: `minimal`, `facts-right`, `hero-stat`,
  `threshold-band`, `sparse-wide`, and supported alternatives
- `table_treatment`: `compact-ledger`, `readout-sidecar`,
  `decision-matrix`, `journal-grid`, or `standard`
- `figure_table_treatment`: `figure-first`, `table-first`, `stats-strip`, or
  `image-sidebar`

Use these controls because they fit the argument, not to cycle through every
available mode.

## Slide Planning

- Give every content slide a clear role: context, evidence, method,
  comparison, implication, decision, or close.
- Give every content slide a visual/evidence anchor: chart, table, figure,
  image, stats, KPI, structured comparison, or intentionally designed report
  body.
- Vary composition with the story. Do not repeat the same header, card grid,
  or two-column shell on most slides.
- Prefer evidence-first variants for scientific and lab decks:
  `scientific-figure`, `image-sidebar`, `lab-run-results`, `chart`, and
  `table`.
- Use `kpi-hero`, dark sections, timelines, flows, and cards only when the
  content benefits.
- Keep one dominant object and a deliberate scan path. Avoid awkward unused
  regions and crowded edge zones.
- Reserve footer space before laying out the body.

Readable defaults:

- Title floor: 24 pt
- Body floor: 12 pt
- Caption floor: 7.5 pt
- Chart label floor: 7 pt
- Footer reserve: at least 0.25 in

Shorten, split, or convert dense prose into evidence objects before shrinking
below the deck's readability contract.

## Data And Figures

When local CSV/TSV/XLSX/JSON data should produce reproducible evidence:

```bash
python3 scripts/build_workspace.py \
  --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck \
  --fast-first-pass
```

Or scaffold separately:

```bash
python3 scripts/scaffold_figure_artifacts.py \
  --workspace /ABSOLUTE/RUNTIME/WORKSPACE/decks/my-deck \
  --run \
  --bind-outline
```

Keep the generated figure script, source fingerprints, chart/table JSON,
artifact manifest, analysis summary, slide bindings, and rebuild commands.
Solve figure whitespace and label readability in the figure script before
placing the image on a slide.

Use source-backed images when they improve the deck. Stage them through
`asset_plan.json` and preserve attribution. Generated imagery is optional,
must include prompt/model/purpose metadata, and should be removable without
breaking the narrative.

## Delegation

The main agent owns the final deck and source edits. Use scouts only for
independent, bounded work:

- design/content route for a genuinely ambiguous high-stakes deck;
- data analysis for local datasets or computed evidence;
- content research for source-backed public claims;
- fresh-eyes visual critique after render.

Scouts return decisions, findings, or artifact recommendations. They should not
copy full workspace state, command ladders, or replay ledgers. The main agent
verifies their output, edits source, builds, and accepts the final artifact.

## QA Loop

For deliverable decks:

1. Run planning/preflight and geometry/readability QA.
2. Render the PPTX and inspect the contact sheet plus individual slides.
3. Check visible text for placeholders.
4. Fix source, rebuild, and rerun affected checks.
5. Run final delivery readiness.

Direct render and review:

```bash
python3 scripts/render_slides.py \
  --input /ABSOLUTE/RUNTIME/WORKSPACE/out.pptx \
  --outdir /ABSOLUTE/RUNTIME/WORKSPACE/renders \
  --emit-visual-prompt

python3 scripts/visual_review.py \
  --input /ABSOLUTE/RUNTIME/WORKSPACE/out.pptx \
  --outdir /ABSOLUTE/RUNTIME/WORKSPACE/review \
  --renders-dir /ABSOLUTE/RUNTIME/WORKSPACE/renders \
  --outline /ABSOLUTE/RUNTIME/WORKSPACE/outline.json
```

Placeholder check:

```bash
python -m markitdown /ABSOLUTE/RUNTIME/WORKSPACE/out.pptx | \
  grep -iE "\bx{3,}\b|lorem|ipsum|\bTODO|\[insert|\[placeholder"
```

A successful command is evidence only for the checks it covers. Inspect the
rendered artifact before claiming the deck is finished.

## Development Checks

Use focused checks after changing a workflow lane:

```bash
npm run check:python
npm run check:node
npm run check:focused
```

Renderer or style-treatment changes also require:

```bash
npm run check:style-mix
npm run check:pptxgenjs-regression
```

Model-adaptive brief changes require:

```bash
npm run check:model-adaptive
```

Run a rendered proof whenever visual behavior changes. Validation without a
render is not enough for a presentation skill.
