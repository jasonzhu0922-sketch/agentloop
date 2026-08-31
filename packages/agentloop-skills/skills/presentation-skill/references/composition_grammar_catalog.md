# Composition Grammar Catalog

Use this reference when a deck needs a recognizable argument and page system,
not merely a preset palette. Eight first-class grammars sit above the 13 style
presets:

| Grammar | Reading path | Persistent frame | Primary proof |
|---|---|---|---|
| `consulting-answer-pyramid` | answer -> proof -> action | report bands | exhibit + implication |
| `scientific-evidence-plate` | question -> method -> result -> limit | figure plate | controlled figure/table |
| `clinical-care-pathway` | cohort -> threshold -> care action | pathway rail | endpoint + action sidecar |
| `editorial-spread` | premise -> scene -> evidence -> close | asymmetric spread | image, quote, annotated graphic |
| `investor-thesis-stage` | problem -> proof -> economics -> ask | reveal stage | product or growth proof |
| `operations-grid` | state -> variance -> owner -> due | stable operating grid | target/actual/owner register |
| `policy-public-docket` | public question -> options -> accountability | docket index | map or option matrix |
| `technical-telemetry-canvas` | state -> signal -> failure -> recovery | telemetry frame | aligned signals and event log |

Each grammar provides `renderer_role_contracts_v2` with normalized slots for
title, section, evidence, comparison, chart, table, decision, and references.
Every role has eight color-independent structural systems across the catalog,
plus a v1 fallback. The grammar also carries one narrative arc, grid, density,
reading path, preferred role variants, invariant moves, and forbidden moves.
A grammar may serve at most two presets.

## Route A Request

```bash
python3 scripts/composition_grammar_catalog.py \
  --topic "Q3 retention operating review" \
  --user-prompt "Board decision with variance chart, owner table, and risk tradeoff" \
  --style-preset data-heavy-boardroom
```

Validate the catalog:

```bash
python3 scripts/composition_grammar_catalog.py --summary
```

Normal workspace initialization persists the result in:

- `design_brief.json:style_system.renderer_role_systems_v1`
- `design_brief.json:style_system.renderer_role_contracts_v2`
- `design_brief.json:style_system.style_execution_plan`
- `design_brief.json:structure_strategy.composition_grammar`
- `style_contract.json:renderer_role_systems_v1`
- `style_contract.json:renderer_role_contracts_v2`
- `outline.json:metadata.renderer_role_systems_v1`
- `outline.json:metadata.renderer_role_contracts_v2`

New workspaces persist both compatibility layers and render through v2.
Existing v1-only workspaces stay pinned. Upgrade explicitly with
`scripts/upgrade_renderer_role_contracts_v2.py --workspace <path>`; the command
is idempotent and does not change the workspace version marker.

## Mixing Rules

1. Keep the primary grammar's frame, navigation, reading path, and role-system
   IDs coherent.
2. Treat preferred variants as candidates ordered by the argument, never as a
   mandatory template sequence.
3. Borrow at most two bounded treatments from secondary influences. Do not
   borrow another grammar's complete cover, frame, or navigation.
4. Explicit user, brand, accessibility, and evidence constraints override the
   default route and must be recorded.
5. A slide may set `role_layout_variant` to `primary`, `alternate`, or `dense`
   when the evidence shape requires it; arbitrary coordinates are not part of
   the outline contract.
6. Avoid repeating one skeleton more than twice unless the repeated evidence
   truly needs synchronized comparison.

## Diversity Gate

```bash
python3 scripts/run_controlled_style_diversity_smoke.py --render \
  --outdir /tmp/presentation-skill-structural-diversity
```

The v2 evaluator ignores color, fills, strokes, and decorative-only shapes. It
clusters semantic occupancy, topology, anchor geometry, hierarchy/reading
order, and whitespace zoning for nine controlled roles. Every role requires
at least eight clusters, a largest cluster of at most two presets, normalized
entropy of at least `0.78`, and zero cross-grammar clusters. Edge hashes remain
diagnostics, not proof of taste.
