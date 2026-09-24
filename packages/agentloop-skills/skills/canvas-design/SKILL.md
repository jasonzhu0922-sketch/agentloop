---
name: canvas-design
description: Create original single-page posters and static visual art as PNG or PDF, prioritizing brief-specific creative direction and custom composition while using the packaged renderer only for genuinely simple, compatible briefs.
license: Complete terms in LICENSE.txt
agentloop:
  roles:
    - primary_builder
  artifactKinds:
    - image
    - document
  executionProfiles:
    - local_script
  sourceKinds: []
  qaKinds: []
---

# Canvas Design

Create two artifacts:

1. A concise, subject-specific design philosophy in Markdown.
2. A single-page PNG or PDF that visibly realizes that philosophy.

The philosophy is a design decision, not decorative prose. Its choices must survive into the render spec and the finished image.

Creativity and truthful expression of the brief take priority over renderer reuse. Design the work first, then select an implementation that can realize it without dropping content, flattening hierarchy, or replacing requested spatial relationships with generic decoration. The packaged renderer is a constrained fast path, not the default definition of a poster. A custom renderer is a normal first-class path, not a failure or last resort.

## Preserve the brief as a design contract

Before proposing directions, extract a compact brief contract containing:

- `mandatoryCopy`: every user-owned phrase that must appear, preserving meaningful grouping and emphasis;
- `reservedZones`: required clear or replaceable regions such as a QR code, logo, portrait, product screenshot, sponsor block, seal, registration panel, or contact area;
- `contentStructure`: named sections and their relationships, such as hero, capability list, evidence panel, CTA, and footer;
- `recognizableSubjects`: people, products, places, objects, or symbols that must be visibly represented;
- `deliveryConstraints`: size, format, orientation, brand assets, safe margins, and print or screen requirements;
- `distinctnessConstraints`: references or prior outputs that the new work must preserve, avoid, or materially differ from.

Treat these as acceptance constraints, not optional inspiration. Do not merge several required sections into a generic label list, shorten or omit mandatory copy to fit a renderer, or represent a reserved zone only in the philosophy. A reserved zone must have an explicit placement, size or proportion, clearance rule, and visual treatment in the implementation plan.

Keep this contract renderer-neutral. Do not add a scenario-specific field to a generic renderer merely to satisfy one poster. A QR placeholder is one instance of a general reserved region; the same contract must also work for logos, screenshots, portraits, seals, and other replaceable assets.

## Inspect packaged capability without letting it choose the design

Load the current packaged-renderer schema before assigning its enum values or deciding that it can implement a direction:

`python3 -c "import os,runpy;runpy.run_path(os.path.join(os.environ['AGENTLOOP_SKILL_ROOT_CANVAS_DESIGN'],'scripts','render_static_canvas.py'), run_name='__main__')" --schema`

Treat the returned art-direction values, layout families, composition variants, motif kinds, and topology mappings as the packaged renderer's executable contract. Do not invent enum values and repair them after rendering fails. The schema is a capability inventory, not a menu that limits the candidate directions. The renderer does not infer visual direction from the subject, title, labels, industry, mood, or `designIntent`; every packaged render spec must carry an explicit `artDirection`.

Do not begin by choosing a layout family and then write a philosophy that rationalizes it. Candidate concepts may exceed the packaged grammar. Record those candidates honestly and choose a custom renderer when they are best for the brief.

## Find a distinct direction

Read the brief for its purpose, audience, emotional stakes, mandatory copy, recognizable subjects, and delivery constraints. A topic category such as technology, enterprise, culture, or commemoration does not imply a visual style.

Before choosing a direction, form three coherent candidates that differ on at least four of these axes:

- emotional register
- material language
- composition topology
- typographic voice
- color strategy
- image mode
- central visual metaphor

Changing only the movement name, palette, seed, or arrangement of the same lines and nodes does not create a new direction. If earlier posters or reusable artifacts are available, compare their thumbnail silhouettes. Reject a candidate that repeats the same dominant mass, title zone, material treatment, and metaphor without a brief-specific reason.

The candidate set itself must be diverse. Every pair must differ on at least four axes, including composition topology or central metaphor. When the brief does not fix them, use three different topologies, at least two color strategies, and at least two material languages and image modes. Include one counter-default direction that expresses the subject without the category's familiar palette, glow, geometry, or iconography while preserving the requested tone. A set of three dark technological scenes, three centered monuments, or three variants of the same luminous structure fails this gate.

For each candidate, keep a compact decision record containing its concept, seven axes, thumbnail silhouette, likely rendering path, brief evidence, and main tradeoff. Use packaged enum values when that renderer is a plausible path; describe the axes plainly when a custom renderer better fits the concept. Do not distort a custom concept merely to make every candidate fit packaged enums. Do not write the philosophy or spec until this comparison has produced either an evidence-backed selection or a HIL request. Mentioning three possibilities only in hidden reasoning does not satisfy this gate; preserve the comparison in the HIL options or in the philosophy's design-decision section.

## Revise a prior poster without cloning its form

When the task refines, corrects, or changes a prior poster, inspect its actual image and its prior `artDirection` before proposing a new render spec. Record a `revisionIntent` in the philosophy with three fields: `preserve`, `replace`, and `reason`.

`preserve` may retain brief-owned constraints such as required copy, brand assets, tone, or delivery size. It must not silently retain topology, central metaphor, title zone, material language, color strategy, or image mode merely because they appeared in the previous spec. A request to change style, add visual complexity, or shift emphasis requires a new candidate comparison against the prior thumbnail. The new direction must change at least four visual axes, including composition topology or central metaphor, unless the user explicitly requires the previous form to remain; state that explicit reason in `reason`.

Do not turn “keep a dark, formal technology tone” into “keep the dark network field.” Tone constrains emotional register; it does not authorize reusing a composition grammar, title placement, motif set, or visual metaphor.

## Resolve material style ambiguity with HIL

After consulting the schema and forming the candidate directions, decide whether the brief contains enough visual evidence to select one. Mood, quality, sector, and topic words constrain purpose or emotional register; they do not by themselves determine material, topology, typography, color, image mode, or metaphor through familiar genre associations.

Use `request_human_loop` before writing the philosophy, spec, or artwork when a critical style characteristic cannot be inferred and different answers would produce materially different work. Critical characteristics include the emotional register, material language, composition topology, typographic voice, color strategy, image mode, and central metaphor. Choose the rendering implementation from the confirmed direction and the loaded schema; that implementation choice does not require user input.

A direction may bypass HIL only when at least one of these supplies a clear selection basis:

- the user names or describes the visual form, metaphor, material, image treatment, or composition;
- supplied brand assets or visual references materially constrain those choices;
- the user explicitly delegates the unresolved visual direction, such as asking to be surprised or to use the designer's judgment.

Sector, audience, purpose, topic, event type, and mood adjectives never satisfy this bypass by themselves. Do not treat technology, enterprise, governance, industrial, launch, formal, premium, grand, energetic, friendly, restrained, or similar category signals as evidence for a particular topology, material, palette, image mode, or metaphor. A candidate being familiar or conventional for the category is not stronger evidence.

When none of the three explicit bypass conditions applies and two or more candidates remain viable, HIL is required. This is a stop gate: do not write the philosophy, create the spec, render the artwork, or call an artifact-writing tool before the HIL response. For example, a brief that only names an enterprise technology launch and asks for a solemn, grand, technological tone must present three directions through HIL because it still leaves the visual form and metaphor open.

Prefer a single-choice `selection` request containing three coherent directions. Each option must state its metaphor, thumbnail silhouette, material and color character, practical tradeoff, seven axes, and whether it is best served by a custom or packaged renderer. Validate the option set against the diversity gate before calling HIL. Do not hide a stronger custom direction merely because a packaged option is easier to execute. When HIL is required because the brief does not favor a direction, present the options neutrally: do not mark a familiar or genre-default candidate as recommended, preferred, or preselected. Use a `confirmation` request only when there is one evidence-backed interpretation and the user needs to approve or reject it. State exactly which preference is missing, cite the brief and schema result in `evidenceRefs`, and resume with `continue_step`. Once answered, treat the response as authoritative design input and continue the same step without asking again.

Do not use HIL to recover from an invalid spec, unsupported enum, unsupported motif, or render failure. Correct those implementation errors from the loaded schema or use a custom renderer. Do not ask the user to decide every axis independently or to approve a direction already specified by the brief. Do not silently select a genre-default direction merely to avoid HIL.

Select the direction that makes the subject most legible and memorable. Preserve it as an `artDirection` object:

```json
{
  "concept": "A civic service is revealed as a living public noticeboard",
  "emotionalRegister": "humanist",
  "materialLanguage": "ink-paper",
  "compositionTopology": "modular-editorial",
  "typographicVoice": "editorial-contrast",
  "colorStrategy": "warm-editorial",
  "imageMode": "collaged-fragments",
  "avoid": ["dark network field", "glowing central orb", "technical dashboard labels"]
}
```

Allowed values are listed by `scripts/render_static_canvas.py --schema`. `concept` and `avoid` remain specific to the brief; the other fields form a stable renderer contract.

## Write the philosophy

Write three to five focused paragraphs. Name the movement, then explain how this subject becomes visible through the selected metaphor, space, material, color, type, scale, and rhythm. State what the direction deliberately excludes when that protects its identity.

Ground the philosophy in the brief. Do not write a reusable manifesto that could accompany any poster. Avoid automatic claims about museum quality, countless hours, sophistication, restraint, minimal text, dark fields, glowing cores, grids, or geometric precision. Use those qualities only when this direction actually calls for them.

Text can be quiet, loud, dense, fragmented, monumental, or image-like. Its role follows the brief and the selected typographic voice. Preserve every piece of mandatory copy and keep it legible within the canvas.

## Choose the rendering path

Choose the rendering path only after the brief contract and visual direction are stable. Default to a custom renderer for brand posters, campaign key art, and other composition-led work where originality, hierarchy, or conversion structure materially affects success.

Use the packaged renderer only when every condition below is true:

- the content model is genuinely simple: one title, one subtitle, and no more than eight compact peer labels;
- there are no reserved zones, CTA panels, contact blocks, logos requiring controlled placement, screenshots, sponsor areas, or other replaceable regions;
- there are no multiple named sections whose hierarchy or spatial relationship must be preserved;
- one packaged grammar and its supported motifs directly express the selected metaphor and thumbnail silhouette;
- all mandatory copy fits the documented fields without shortening, merging, demoting, or converting sections into decorative labels;
- the requested image treatment does not require photography, detailed illustration, hand lettering, a narrative scene, product UI, or another unsupported grammar;
- the result can remain distinctive within the chosen grammar rather than merely changing palette, seed, or ornament.

If any condition is false or uncertain, use a compact custom renderer. The burden is to demonstrate packaged-renderer compatibility, not to demonstrate why custom work is exceptional.

Do not force a direction through the packaged renderer merely because it is faster, already available, or easier to validate technically. Never delete copy, collapse sections, discard a reserved zone, or change the central metaphor to make the brief fit its schema. `layoutFamily` describes form; `designIntent` describes subject purpose. They are independent.

For a custom renderer, preserve the same design discipline: materialize the brief contract and selected direction in workspace-owned source, use explicit layout measurements for required regions, verify glyph coverage, and keep the implementation no more specialized than the selected artwork requires. Custom means purpose-built composition, not unstructured improvisation.

## Production execution architecture

Use the package-owned `canvas-production` executor actions exposed by `load_skill` as the normal production path. This is a persistent workflow, not a suggestion to author a full Pillow program in model output.

Execute the following phases in order:

1. Run `preflight` once and persist its `canvas-runtime-profile.json`. Reuse the package-owned `assets/fonts/NotoSansSC.ttf` CJK-safe font profile; do not write ad-hoc font probes, scan arbitrary system directories, or install a font library during a normal canvas task. If that asset is unavailable or cannot render the requested visible text, report the package/runtime failure rather than silently substituting a host font.
2. Write one compact `agentloop.canvasDesignDocument/v1` JSON document in the workspace. It is the durable handoff between design and production. It contains `briefContract`, `artDirection`, normalized `sections`, `visualMotifs`, canvas settings, and a relative PNG `output.path`.
3. Run `validate-design` on that exact document. Repair the document when validation fails; do not bypass it by changing a renderer or flattening the brief.
4. Run `render` on the validated document. The package scaffold owns CJK font selection, base composition, section geometry, reserved-region treatment, PNG export, and structural render receipt.
5. Run `inspect`, then inspect the actual image at full size and thumbnail size. Finally call the Runtime artifact-acceptance tool when it is available.

The document's `sections` use normalized rectangles `{x,y,width,height}` in the 0–1 canvas coordinate space. Every mandatory copy item must appear exactly once in `briefContract.copyDestinations`, which names its rendered `sectionId` and field (`title`, `copy`, or `items`); every reserved zone must contain `id`, `label`, `rect`, and optional `clearance`. The scaffold deliberately treats a QR block, logo, portrait, screenshot, seal, and contact region as the same generic reserved-zone contract.

Do not write a complete custom image renderer for ordinary posters. The production scaffold is the implementation boundary. If a future brief genuinely needs an unsupported image operation, preserve this document and add a narrowly scoped package capability rather than reconstructing fonts, layout, export, and acceptance in a task workspace.

The packaged renderer lives at `scripts/render_static_canvas.py`. From a writable workspace, run it through the injected Skill root:

`python3 -c "import os,runpy;runpy.run_path(os.path.join(os.environ['AGENTLOOP_SKILL_ROOT_CANVAS_DESIGN'],'scripts','render_static_canvas.py'), run_name='__main__')" spec.json`

Do not pass `@skills/...` or absolute Skill paths as command arguments.

## Constrained packaged render contract

Use this contract only after the eligibility gate above passes. Write a compact JSON spec and copy the selected `artDirection` exactly from the philosophy decision into it. New specs with a `designIntent` require `artDirection`.

```json
{
  "output": "poster.png",
  "title": "城市智能服务周",
  "subtitle": "技术回到街道与日常",
  "movement": "Public Patchwork",
  "designIntent": "technology-system",
  "artDirection": {
    "concept": "Digital services behave like layered notices gathered across a city",
    "emotionalRegister": "humanist",
    "materialLanguage": "ink-paper",
    "compositionTopology": "modular-editorial",
    "typographicVoice": "editorial-contrast",
    "colorStrategy": "warm-editorial",
    "imageMode": "collaged-fragments",
    "avoid": ["dark network field", "glowing central orb"]
  },
  "layoutFamily": "editorial-blocks",
  "compositionVariant": "split-spread",
  "labels": ["公共服务", "社区共创", "开放数据", "街区实验"],
  "visualMotifs": [
    {"kind": "building", "label": "街区"},
    {"kind": "figure", "label": "市民"}
  ],
  "texture": 0.28,
  "density": 0.58,
  "seed": 311,
  "canvas": {"width": 1800, "height": 2700}
}
```

The renderer derives a default palette, texture, density, family, and variant from `artDirection`. It never derives a direction or layout from keywords in the title, labels, or `designIntent`. Explicit values may refine that direction but must not contradict it. Unsupported family and variant names fail instead of silently falling back.

Composition topology maps to the packaged grammar:

- `networked-field` → `signal-field`
- `axial-monument` → `monument-axis`
- `modular-editorial` → `editorial-blocks`
- `directional-flow` → `kinetic-ribbons`
- `symbolic-grid` → `emblem-grid`

These mappings describe geometry, not subject matter. A technology poster can be modular, kinetic, symbolic, axial, or networked when the concept justifies it.

`visualMotifs` contains up to six visible subject elements. Supported kinds are returned by `--schema`. Motifs must act as graphic subjects, not as footer labels standing in for an illustration. If the requested subject cannot be represented by these motifs, use a custom renderer.

Use CJK text directly. Before export, verify that the chosen font covers every visible character. The packaged renderer performs font selection and glyph smoke checks. A custom renderer must fail clearly when it cannot find compatible glyphs; never deliver tofu or replacement boxes.

Before rendering, compare the implementation inputs with the brief contract. Every `mandatoryCopy` item, `reservedZones` entry, named content section, and recognizable subject must have an explicit destination. If the mapping is incomplete, stop and revise the rendering path or implementation; do not render and hope visual inspection will recover the omission.

## Inspect the result

Inspect the actual image once at full view and once as a small thumbnail. Confirm:

- the thumbnail silhouette matches the selected composition topology;
- material, color, type, and image treatment match `artDirection`;
- the central metaphor is visible rather than described only in labels;
- every mandatory-copy item is present, legible, correctly grouped, and free of collisions;
- every reserved zone exists at the required placement and proportion, remains clear of decorative intrusion, and is visibly usable for its intended replacement asset;
- named sections retain their intended hierarchy and spatial relationships instead of collapsing into a flat label field;
- recognizable subjects are visibly represented in the promised image mode;
- the result is meaningfully distinct from relevant earlier posters when those are available.

Technical artifact acceptance proves that the file exists and decodes. It does not prove brief coverage, reserved-region preservation, design quality, or diversity. Do not claim completion until the visual inspection has checked the brief contract. If refinement is needed, change the weak design decision, rendering path, or composition instead of merely adding decoration.

Output the final PNG or PDF alongside the Markdown philosophy. For multiple requested pages, keep one coherent philosophy while varying composition and pacing across pages.
