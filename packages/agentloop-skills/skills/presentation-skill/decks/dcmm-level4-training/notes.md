# DCMM 4级（量化管理级）培训课件 Notes

## Purpose

- Audience:
- Decision / outcome:
- Style preset: `executive-clinical`
- Style reference: `ref-exec-clinical-evidence-brief` / Clinical Evidence Executive Brief
- Style metrics: `style_reference_metric_profile_v1`; density `medium-high evidence brief`; whitespace target `0.24`; body-word budget `34, 58`.
- Starter scaffold: `style_reference_starter_outline_v1` synthetic examples; replace before delivery.

## Sources

- Add the datasets, URLs, or reference decks used to author this presentation.
- Record the provenance for every non-user image you stage through `asset_plan.json`.
- Promote researched claims into `evidence_plan.json` before adding them to slides.

## Research log to staging plan

Closes the gap where research produces good content but never turns into
staged visuals. Every row in this table should eventually trigger an
entry in `asset_plan.json` (wikimedia_query for a CC photo, or a staged
icon/chart).

| Fact discovered | Source | Becomes | In asset_plan as |
|---|---|---|---|
| _e.g. Chicago Pile-1, first controlled chain reaction, Dec 2 1942_ | _en.wikipedia.org/Chicago_Pile-1_ | _hero image on slide 3_ | _images[0].wikimedia_query: "Chicago Pile-1"_ |
|  |  |  |  |
|  |  |  |  |

If this table is empty at build time, ask yourself whether the deck
actually has no visual anchors or whether the research hasn't been
connected to the staging plan yet.

## Style Contract

- Slide size: 16:9 unless a reference deck says otherwise
- Title font: 44-34pt range via preset
- Section font: 30-24pt range via preset
- Body font: 22-15pt range via preset
- Margin x: 0.7
- Gutter: 0.28
- Style DNA: Quiet hospital-grade executive pages: large evidence headline, one controlled clinical accent, and clear implication blocks.
- Preferred variants: title, chart, lab-run-results, comparison-2col, image-sidebar, table, standard
- Chart treatment: Outcome chart with right-side clinical readout and n/r/source footnote.
- Table treatment: Protocol table with semantic pass/review/fail fills and short row labels.
- Decision treatment: Recommendation strip framed as clinical action, owner, and evidence confidence.

## QA Notes

- Preserve alignment first.
- Keep subtitles below wrapped titles.
- Prefer local, source-backed assets in `assets/`.
- Use `asset:alias` references in `outline.json` after staging into `assets/staged/`.
- Add any deck-specific measurements here if you later match an existing deck manually.
