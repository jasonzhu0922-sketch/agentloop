---
name: presentation-skill
description: "Build, edit, redesign, render, and verify polished editable PowerPoint `.pptx` decks from a prompt, structured `outline.json`, local data, or a saved workspace. Use for presentation and slide-deck generation, lab/clinical/scientific reports, board and investor decks, editorial briefs, charts/tables/figures, template-inspired redesign, geometry/readability QA, rendered visual review, and reproducible deck workspaces. Aliases: PowerPoint skill, PPTX skill, presentation generator, slide-deck generator, deck builder, powerpoint-deck-builder, pptx-skill."
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
- Run QA and inspect rendered slides before delivering a deck.
- Never install dependencies during a deck task. Report a missing dependency.
- Scaffold a new topic from its own evidence and story. Do not clone another
  deck's slide sequence as a house style.

## Start Here

Read only the context needed for the current phase:

1. `DESIGN.md` for the compact design contract.
2. `references/outline_schema.md` for fields and supported variants.
3. `references/model_adaptive_workflow.md` for execution-profile selection.

Then load one task-specific reference:

- Saved/rebuildable deck: `references/deck_workspace_mode.md`
- Existing PPTX edit: `references/editing.md`
- Data/figure workflow: `references/reproducible_workflow.md`
- Style inspiration or screenshot/template matching:
  `references/style_reference_catalog.md`
- Structural diversity or topic-to-grammar routing:
  `references/composition_grammar_catalog.md`
- PptxGenJS renderer changes: `references/pptxgenjs.md`
- Fresh-eyes rendered QA: `references/visual_qa_prompt.md`

Do not preload the corpus, all preset descriptions, or every workflow
reference. Search or open the selected item on demand.

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
  --workspace decks/my-deck \
  --title "My Deck" \
  --style-preset executive-clinical \
  --user-prompt "Original request" \
  --agent-profile auto
```

Read `agent_brief.md` first. It contains the active profile, style route,
commands, and completion rubric. Keep `deck_start_packet.json` on disk for
audit/recovery; do not paste it into the active model prompt.

To regenerate only the brief:

```bash
python3 scripts/model_adaptive_workflow.py \
  --workspace decks/my-deck \
  --packet deck_start_packet.json \
  --agent-profile auto
```

## Choose The Workflow

### Quick Deck

Use for a one-off 5-10 slide deck when no future rebuild workspace is needed.
Author `outline.json`, then:

```bash
node scripts/build_deck_pptxgenjs.js \
  --outline outline.json \
  --output out.pptx \
  --style-preset <preset>

python3 scripts/qa_gate.py \
  --input out.pptx \
  --outdir /tmp/pptx-qa \
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
python3 scripts/report_workspace_readiness.py --workspace decks/my-deck
```

Build a fast source-first pass:

```bash
python3 scripts/build_workspace.py \
  --workspace decks/my-deck \
  --qa \
  --skip-render \
  --fail-on-planning-warnings \
  --fail-on-whitespace-warnings \
  --overwrite
```

Build the final rendered candidate:

```bash
python3 scripts/build_workspace.py \
  --workspace decks/my-deck \
  --qa \
  --visual-review \
  --fail-on-visual-review-warnings \
  --fail-on-planning-warnings \
  --fail-on-whitespace-warnings \
  --overwrite
```

Finish with:

```bash
python3 scripts/report_delivery_readiness.py --workspace decks/my-deck
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
  --workspace decks/my-deck
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
  --outdir /tmp/presentation-skill-controlled-diversity
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
  --workspace decks/my-deck \
  --fast-first-pass
```

Or scaffold separately:

```bash
python3 scripts/scaffold_figure_artifacts.py \
  --workspace decks/my-deck \
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
  --input out.pptx \
  --outdir renders \
  --emit-visual-prompt

python3 scripts/visual_review.py \
  --input out.pptx \
  --outdir review \
  --renders-dir renders \
  --outline outline.json
```

Placeholder check:

```bash
python -m markitdown out.pptx | \
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
