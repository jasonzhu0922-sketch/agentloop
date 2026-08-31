---
name: html-skill-effectiveness-main
description: Generate self-contained, polished single-file HTML artifacts for reports, dashboards, demos, and presentation-style pages.
agentloop:
  roles:
    - primary_builder
  artifactKinds:
    - html
  sourceKinds: []
  qaKinds: []
  executionProfiles: []
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 263ae02d9b82b898f7b6446bc49bf3dd_cbf4712373c711f1b2f55254006c9bbf
    ReservedCode1: FbSInpO68bnYUTPuXJ7DXd46E/iUC/dh0ApD0wwlrz10jhzDEXBd8NsnrE/1epPGq6LR1j8K2T8uFbwXfelmvh05wERiX9Pc3R+q+dQ/t1hsEcNubFlYIeAr07QRyuD2BPPT9nJKld7m0cdk923RENtaZMQgoK+klwIIc5tjgxpXKJJS9mgyPRbRvDU=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 263ae02d9b82b898f7b6446bc49bf3dd_cbf4712373c711f1b2f55254006c9bbf
    ReservedCode2: FbSInpO68bnYUTPuXJ7DXd46E/iUC/dh0ApD0wwlrz10jhzDEXBd8NsnrE/1epPGq6LR1j8K2T8uFbwXfelmvh05wERiX9Pc3R+q+dQ/t1hsEcNubFlYIeAr07QRyuD2BPPT9nJKld7m0cdk923RENtaZMQgoK+klwIIc5tjgxpXKJJS9mgyPRbRvDU=
---



# HTML Effectiveness v3.0

## Overview

This skill guides the generation of single-file `.html` artifacts that are self-contained (no external dependencies), visually polished, and designed for human consumption. Core philosophy: **trade documents people skim for documents people actually read**.

Every artifact is one HTML file with inline CSS and JavaScript. No build step. No dependencies. Open directly in a browser.

**Evolution Note**: Combines the structured pattern catalog from [html-effectiveness](https://github.com/ThariqS/html-effectiveness), bold aesthetic philosophy from [frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) by Anthropic, and engineering rigor from [open-design](https://github.com/opendesign).

**v3.0 Craft Discipline**: Seven enforceable craft rules — anti-ai-slop, color, typography, typography-hierarchy, animation-discipline, accessibility-baseline, laws-of-ux — plus state-coverage and form-validation contracts. These are checkable constraints, not style preferences. Every artifact must pass all P0 rules before emitting.

**Scope**: Pure front-end presentation artifacts only. Not suitable for auth/payment/backend logic/real-time database scenarios — refuse and inform user when such requirements arise.

---

## Workflow

### Step 0 — Pre-flight

1. **Read this SKILL.md end-to-end** — understand the design system, pattern catalog, and hard rules.
2. **Understand the user's intent** — purpose, tone, audience, density.
3. **Map to Pattern Catalog** — choose the closest pattern (1-13) and aesthetic direction.
4. **Plan the section list** — state your chosen layout in one sentence to the user BEFORE writing.

### Step 1 — Choose aesthetic direction

Commit to a **BOLD aesthetic direction** before coding:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme — editorial/magazine (Monocle, Kinfolk), brutalist/raw (Balenciaga, Vitsoe), luxury/refined (Hermès, Aesop), minimalist/swiss (Muji, Apple), playful/toy-like (Lego, Duolingo), retro-futuristic (Blade Runner, Cyberpunk 2077), organic/natural (Patagonia, Aēsop), art deco/geometric (Great Gatsby, Chrysler), soft/pastel (Glossier, Uniqlo), industrial/utilitarian (Muji hardware, Vitsoe shelving), maximalist/chaos (MSCHF, Virgil Abloh).
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**Tuning Knobs**: Users may pass `--variance=N --motion=N --density=N` to fine-tune output style:
- **VARIANCE** (1-10): How far to deviate from conventional design. 1 = safe/conservative; 10 = experimental/unexpected.
- **MOTION** (1-10): Quantity and intensity of animations. 1 = static/minimal; 10 = cinematic/rich.
- **DENSITY** (1-10): Information density and white space ratio. 1 = airy/sparse; 10 = data-dense/compact.
- Default: 5 (medium) for all three when not specified.

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work — the key is intentionality, not intensity.

### Step 2 — Write the artifact

1. **Copy the HTML Structure Template** (see below) as your seed.
2. **Define tokens** in `:root` — map colors to the six core variables (see Design System).
3. **Build sections** — compose from Pattern Catalog. Adapt the closest pattern; don't write from scratch.
4. **Add interaction** — minimal JS, CSS-first.
5. **Tag sections** — add `data-od-id="slug"` on every `<section>` for traceability.

### Step 3 — Self-check & Critique

Run through the **Quality Checklist** (P0/P1/P2). **Every P0 item must pass before you emit.**

Then run the **5-Dimension Self-Critique**. Score each dimension 0-10 with cited evidence. If any dimension scores < 4, enter DevLoop.

### Step 4 — Emit the artifact

```
<artifact identifier="kebab-case-slug" type="text/html" title="Human Title">
<!doctype html>
<html>...</html>
</artifact>
```

One sentence before the artifact describing what's there. Stop after `</artifact>`.

---

## Design System

### Core Token Philosophy

Use **six core variables** in `:root`. Everything else derives from these via `color-mix()`. No raw hex outside `:root`.

```css
:root {
  --bg:      #fafaf7;   /* page background — never #fff */
  --surface: #ffffff;   /* cards, modals, raised areas */
  --fg:      #1a1916;   /* primary text — never #000 */
  --muted:   #6b6964;   /* secondary text, captions */
  --border:  #e8e5df;   /* hairlines, dividers */
  --accent:  #c96442;   /* one accent — used at most 2× per visual region */

  /* derived — use color-mix(), do not add more tokens */
  --accent-soft: color-mix(in oklch, var(--accent) 14%, transparent);
  --fg-soft:     color-mix(in oklch, var(--fg) 6%, transparent);
}
```

**Why six tokens?** Constraints breed consistency. For full 16-color palette and 4 alternative schemes (Dark/Luxury, Soft/Pastel, Brutalist, Industrial), see `references/palette-examples.md`. For aesthetic × brand mappings, see `references/style-recipes.md`.

### Typography Tokens

```css
:root {
  --font-display: 'Iowan Old Style', 'Charter', Georgia, 'Times New Roman', serif;
  --font-body:    -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono:    ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, monospace;
}
```

| Element | Font | Size | Weight | Notes |
|---------|------|------|--------|-------|
| H1 (page title) | var(--font-display) | clamp(44px, 6vw, 76px) | 500 | letter-spacing: -0.02em |
| H2 (section) | var(--font-display) | clamp(32px, 4vw, 48px) | 500 | letter-spacing: -0.015em |
| H3 (card title) | var(--font-display) | 22px | 600 | letter-spacing: -0.005em |
| Body | var(--font-body) | 16px | 400 | line-height: 1.55 |
| Eyebrow / Label | var(--font-mono) | 11-12px | 400 | uppercase, letter-spacing: 0.08em |
| Code / File | var(--font-mono) | 11-13px | 400 | inline background: var(--gray-100) |
| Caption / Meta | var(--font-body) | 13px | 400 | color: var(--muted) |

**Font philosophy**: Use system font fallback chains. Prefer distinctive, beautiful typefaces — but always with full system fallback. Avoid Inter/Roboto/Arial as display faces. Maximum 2 typefaces per artifact.

### Spacing & Radius

```css
--radius-panel: 12px; --radius-row: 8px; --radius-pill: 999px;
```

Page padding: `56px 24-32px 96-120px`. Max-width: `860-1180px` depending on density.

**8-point grid**: `--gap-xs: 8px; --gap-sm: 12px; --gap-md: 20px; --gap-lg: 32px; --gap-xl: 56px; --gap-2xl: 96px;`

### Core CSS Reset

```css
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
body {
  margin: 0; font-family: var(--font-body); background: var(--bg);
  color: var(--fg); line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
img, svg { display: block; max-width: 100%; }
a { color: inherit; text-decoration: none; }
button { font: inherit; cursor: pointer; }
p { text-wrap: pretty; }
h1, h2, h3, h4 { text-wrap: balance; }
```

---

## Craft Rules · 工艺纪律

These are **enforceable constraints**, not style preferences. Every artifact must pass all P0 rules before emitting. Any P0 violation = do not emit. Fix first.

---

### 1. Anti-AI-Slop · 反 AI 味

| # | Sin | Why it's wrong | Fix |
|---|---|---|---|
| 1 | **Default Tailwind indigo as accent** (`#6366f1`, `#8b5cf6`, `#a855f7`) | Most reliable AI tell | Use `--accent` from `:root`; never hardcode indigo |
| 2 | **Two-stop "trust" gradient on hero** (purple→blue, blue→cyan) | Template skeleton | Flat surface + intentional typography beats this |
| 3 | **Emoji as feature icons** (`✨` `🚀` `💡` in headings/buttons) | Lazy | Use 1.6–1.8px stroke monoline SVG with `currentColor` |
| 4 | **Sans-serif on display text** when `:root` binds a serif | Inconsistent | `h1`/`h2` MUST use `var(--font-display)` |
| 5 | **Rounded card + colored left-border accent** | Canonical "AI dashboard tile" | Drop either radius or left-border |
| 6 | **Invented metrics** ("10× faster", "99.9% uptime") | Dishonest | Pull from real source or use labelled placeholder |
| 7 | **Filler copy** (`lorem ipsum`, `Feature One/Two`) | Empty | Delete empty sections; compose with real content |

**Soft tells (P1)**:
- Standard Hero→Features→Pricing→FAQ→CTA with no variation
- External placeholder image CDNs (`unsplash.com`, `placehold.co`)
- More than ~12 raw hex values outside `:root`
- `var(--accent)` used 6+ times in rendered body (cap: 2 visible per visual region)

**Soul formula**: ~80% proven patterns + ~20% distinctive choice. The 20% lives in: one bold visual move, voice/microcopy, one memorable micro-interaction, one product-specific detail.

**One-memory rule**: A page has exactly one memorable moment. If two or more visual climaxes compete at equal intensity, keep the strongest one and demote the rest.

---

### 2. Color · 色彩

#### Palette Structure (4 Layers)

| Layer | Share of Pixels | Tokens |
|---|---|---|
| **Neutrals** | 70–90% | `--bg`, `--surface`, `--fg`, `--muted`, `--border` |
| **Accent** (one) | 5–10% | `--accent` ONLY — never invent a second accent |
| **Semantic** | 0–5% | `--success`, `--warn`, `--danger` |
| **Effect** | <1% | Gradients, glows; rarely justified |

#### Accent Discipline

**Each visual region** (one `<section>`, one card group, or above-the-fold) may have at most **2 visible uses** of `var(--accent)`. Typical pair: one eyebrow/chip + one primary CTA.

**How to judge**: Scan the rendered page top to bottom. Count every element where `var(--accent)` is applied as fill, stroke, background, or border-color within the current visual region. Links count as accent; demote to `--fg` underline if also have a CTA on same screen. Hover/focus rings count as accent. Ration accordingly.

#### Contrast Minimums (WCAG)

| Pair | Minimum |
|---|---|
| Body text (≤16px) on background | **4.5:1** |
| Large text (>18px or 14px bold) | **3:1** |
| UI components against adjacent surfaces | **3:1** |

#### Dark Themes

Avoid pure black/white: `--bg: #0f0f0f` (not `#000`); `--fg: #f0f0f0` (not `#fff`). On dark surfaces, prefer semi-transparent white borders (`rgba(255,255,255,0.08)`) over solid dark borders.

#### Anti-Defaults

- **Indigo `#6366f1`** is the most reliable AI-slop tell. If brief truly needs indigo, user must say so explicitly.
- **Two-stop "trust" gradient** on hero is second-most reliable tell.
- **Decorative gradients with no functional purpose** — gradients should separate hierarchies, not decorate empty space.

---

### 3. Typography · 排版

#### Type Scale (Multiplicative: 1.2 or 1.25)

| Role | Range |
|---|---|
| Display | 48–72px |
| H1 | 32–48px |
| H2 | 24–32px |
| H3 | 20–24px |
| Body | 15–18px |
| Small | 13–14px |
| Caption | 11–12px |

Cap at **6–8 sizes per artifact**.

#### Line Height

| Text Size | Line Height |
|---|---|
| Display/H1 (≥32px) | `1.0`–`1.2` (tight) |
| Body (15–18px) | `1.5`–`1.6` |
| Small (≤14px) | `1.5` |

#### Letter-Spacing — No Exceptions

| Context | Letter-Spacing |
|---|---|
| Body text (14–18px) | `0` (default) |
| Small text (11–13px) | `0.01em` to `0.02em` (positive) |
| UI labels and button text | `0.02em` |
| **ALL CAPS** | **`0.06em` to `0.1em` (REQUIRED)** |
| Headings 32px+ | `-0.01em` to `-0.02em` |
| Display 48px+ | `-0.02em` to `-0.03em` |

> **Why `0.06em` floor?** Empirical lower bound from Bringhurst's *Elements of Typographic Style* §3.2.7: 5–10% of em for caps. Anything tighter = counter collision on screen.

#### Font Pairing

- Maximum **2 typefaces** per artifact (display + body, or one variable face at multiple weights).
- Always declare system fallback chain. Prefer system font fallback chains over external font recommendations.
- Never set `font-family: system-ui` alone on a heading — textbook AI default.

#### Line Length

Limit body copy to **50–75 characters per line**: `max-width: 65ch`.

#### Three-Weight System

Most well-crafted UIs use exactly 3 weights:
- **Read** (400/450) — body copy
- **Emphasize** (510/550) — UI text, labels, navigation
- **Announce** (590/600) — headlines, buttons

Weight 700+ is rarely needed.

---

### 4. Typography Hierarchy · 排版层级

#### Three Core Contracts (must satisfy ALL):

1. **One dominant entry point.** One element wins the hierarchy — not two, not three.
2. **Intentional rhythm between levels.** Contrast between levels, not a list of sizes.
3. **Recoverable information flow.** Reader must reconstruct content structure without re-reading.

#### Hierarchy Vectors (use ALL FIVE)

| Vector | What it controls | Hierarchy direction |
|---|---|---|
| Scale | Size contrast between levels | Large → small = primary → secondary |
| Weight | Mass contrast | Heavier = primary |
| Spacing | Breathing room | More space = more visual importance |
| Tracking | Tension and velocity | Tighter = faster; wider = ceremonial |
| Alignment | Relationship to grid/edge | Breaking alignment = importance |

#### Three-Level Working Model

| Level | Role | Typical vectors |
|---|---|---|
| **Primary** | Entry point. One at a time per visual region. | Scale, spacing, or alignment break |
| **Secondary** | Structure. Subdivides or supports primary. | Weight, scale step, or tracking shift |
| **Tertiary** | Incidental. Labels, captions, metadata. | Scale reduction, weight reduction, or positive tracking |

More than three visible levels above the fold = composition problem. Collapse or demote.

#### Anti-Patterns

- **Graduated weight ladder** — reads as default scale, not authored hierarchy.
- **Uniform section spacing** — every gap same value. Vary deliberately.
- **Heading as only hierarchy vector** — spacing/tracking unused.
- **Symmetrical emphasis** — two co-primary elements. Pick one.
- **Size-only hierarchy** — all contrast in font size alone. Fragile.

---

### 5. Animation Discipline · 动画纪律

#### When Motion Earns Its Place

Animation aids comprehension **only** for real-time spatial/temporal reorientation: page transitions, container morphs, viewpoint changes, progress indicators.

**Don't animate to**: teach, decorate, signal "premium", or fill silence.

> **Source**: Tversky/Morrison/Bétrancourt 2002 meta-analysis (IJHCS 57, pp. 247-262).

#### Duration Thresholds

Cross-design-system convergence: **150ms** default (Material 3 `short3`, IBM Carbon `moderate-01`, Shopify Polaris `150`, Tailwind default).

| Duration | Use |
|---|---|
| 50–100ms | Instant feedback (button press, toggle, hover) |
| 150ms | Default for state-confirmation |
| 200–300ms | Entering UI (modals, sheets, dropdowns) |
| 300–500ms | Cross-screen transitions, container morphs |
| >500ms | Reserved for cross-screen, staged, or platform-native transitions |

#### Curve vs Spring

- **Curve** for opacity, color, value-between-two-points.
- **Spring** for position, scale, rotation, gesture-driven motion (physical feel).

Material 3 standard easing: `cubic-bezier(0.2, 0, 0, 1)` (front-loaded). M2 `cubic-bezier(0.4, 0, 0.2, 1)` is legacy.

#### Animation Decision Tree

```
Is this a spatial/temporal state change? → No → Skip animation
  ↓ Yes
Is it position/scale/rotation? → Yes → Use spring
  ↓ No (opacity/color)
Use curve. Duration ≤300ms unless cross-screen.
Always wrap in @media (prefers-reduced-motion: reduce) { animation: none; }
```

#### Reduced Motion

**Every** animation that translates/scales/rotates/parallaxes must respect `@media (prefers-reduced-motion: reduce)`.
- Strip motion-on-axis (translate, scale, rotate, parallax).
- Keep opacity/color crossfades as state-change signal substitute.
- **Flashing limits** (WCAG 2.3.1, Level A): no more than 3 flashes within any 1-second period.

#### Common Mistakes (Lint These)

- "Skeleton screens feel 11% faster" — FALSE. Harrison/Yeo/Hudson CHI 2010 measured progress bars, not skeletons.
- "Doherty Threshold = 400ms" — FALSE. 1982 paper does not contain "400". Lowest measured = 300ms.
- M2 curve `cubic-bezier(0.4,0,0.2,1)` labelled as "Material 3" — FALSE. M3 standard is `cubic-bezier(0.2,0,0,1)`.
- Animation as only signal of state change — reduced-motion users miss it; always pair with static affordance.

---

### 6. Accessibility Baseline · 可访问性底线

**Target: WCAG 2.2 AA** as working ceiling. Clears WCAG 2.1 AA legal floor in both EU (EAA, enforcement live 2025-06-28) and US (ADA Title II 2024). For full jurisdiction comparison and detailed compliance checklist, see `references/accessibility-detail.md`.

#### Color Contrast (WCAG 2.x AA)

| Pair | Minimum | Note |
|---|---|---|
| Normal text (<18pt regular / <14pt bold) | **4.5:1** | |
| Large text (≥18pt regular / ≥14pt bold) | **3:1** | "Large" = 18pt, NOT 18px |
| Non-text UI components and graphical objects | **3:1** | |
| Focus indicator vs adjacent unfocused state | **3:1** | |

#### Touch Targets

| Bar | SC | Size |
|---|---|---|
| **AA (legal floor)** | 2.5.8 Target Size (Minimum) | **24×24 CSS px** |
| **AAA (craft commitment)** | 2.5.5 Target Size (Enhanced) | **44×44 CSS px** |

#### Focus Visibility

Removing focus outline via `outline: none` = **triple failure** (1.4.11, 2.4.7, 2.4.13). Use `:focus-visible` for keyboard users.

#### ARIA Discipline

WebAIM Million 2026: ARIA pages average 59.1 errors vs 42 on non-ARIA pages. **Decision order** (per ARIA APG):
1. Native HTML element with right semantics.
2. Native element under custom visuals if restyling required.
3. APG pattern verbatim if neither fits.
4. Closest APG pattern + documented deviation. **Last resort. Never invent ARIA.**

#### Common Mistakes

- "Target Size 44×44" cited as AA bar — FALSE. 44×44 is **AAA**.
- "18px = large text" — FALSE. Threshold is 18**pt** regular (~24px).
- Bare `<a>` without `href` is NOT a link, not focusable, not keyboard-operable.

---

### 7. Laws of UX · UX 法则

Actionable heuristics grounded in primary research. Full 26-law reference with sources at `references/ux-laws-reference.md`.

| Law | Directive |
|---|---|
| **Proximity** | Related items ≤8px; unrelated ≥24px. |
| **Similarity** | Same type/category = same visual treatment. |
| **Continuity** | Align along continuous lines; don't break visual flow. |
| **Closure** | Partial outlines; let eye complete the shape. |
| **Prägnanz** | Simpler arrangement conveying same info wins. |
| **Figure-Ground** | Active element must pop against background. Grayscale-test. |
| **Focal Point** | One dominant element per screen. |
| **Common Region** | Items inside bounded region = grouped without lines. |
| **Hick's Law** | >7 options → search/filter or group into 3-5 categories. |
| **Choice Overload** | Primary actions ≤3. Bury rest. |
| **Pareto Principle** | Make the 20% prominent; bury the 80%. |
| **Tesler's Law** | Move complexity to where user has most context. |
| **Occam's Razor** | Two paths → simpler one wins. Delete the other. |
| **Miller's Law** | Working memory = 4±1 items (Cowan 2001). Chunk into 3-5. |
| **Peak-End Rule** | Make the peak and the exit deliberate. |
| **Zeigarnik Effect** | Show progress indicators for multi-step flows. |
| **Fitts's Law** | Primary actions ≥44px, near likely cursor position. |
| **Doherty Threshold** | ≤500ms feels instant; ≤200ms feels magical. Target 150ms default. |
| **Postel's Law** | Accept flexible input; output strict standards. |
| **Jakob's Law** | Match familiar patterns for nav/CRUD/auth. |
| **Cognitive Load** | Split complex tasks; progressive disclosure. |
| **Goal Gradient** | Show progress bar; celebrate milestones. |

---

## Pattern Catalog

Choose the pattern that matches the user's intent. **If requirements span multiple patterns**, select the closest primary pattern as the page skeleton and embed auxiliary patterns at the section level.

### 1. Side-by-Side Comparison
**Definition**: A structured grid layout for evaluating multiple options against consistent criteria, with visual emphasis on the recommended choice.
**Structure**: Equal-column grid (2-4), each in a card with consistent internal structure.
**Key techniques**:
- `grid-template-columns: repeat(3, minmax(0, 1fr))`
- Each card: white background, 1.5px border, 12-14px radius
- Highlight recommended option with `--slate` border + subtle shadow
- Trade-off callouts as inline color-coded pills

### 2. Annotated Diff / Code Review
**Definition**: A visual before/after or old/new comparison of code or text with inline severity-tagged annotations.
**Structure**: Two-column or stacked diff blocks with margin notes.
**Key techniques**:
- Old code: strikethrough or muted background
- New code: highlighted with left border (`border-left: 3px solid var(--clay)`)
- Severity tags: `critical` (rust), `warn` (clay), `note` (olive), `style` (gray)
- Line numbers in mono font, muted color

### 3. Module Map / Architecture Diagram
**Definition**: An SVG-based box-and-arrow system diagram showing how components, services, or data flow connect.
**Structure**: Inline SVG with interactive tooltips.
**Key techniques**:
- Boxes: `rect` with rounded corners, fill based on type
- Arrows: `path` or `line` with arrowhead markers
- Hover: show detail panel with `mouseenter`/`mouseleave`
- Hot path: highlight with `--accent` stroke or glow

### 4. Living Design System
**Definition**: A self-documenting reference page displaying color swatches, typography scales, spacing tokens, and component variants.
**Structure**: Organized sections with swatches, live previews, copyable values.
**Key techniques**:
- Color swatches: square divs with hex label
- Typography: sample text at each scale with computed CSS
- Components: render every variant (size, state, intent) in a contact sheet

### 5. Slide Deck
**Definition**: Full-viewport scroll-snap presentation sections with keyboard navigation, speaker notes, and optional visual effects.
**Structure**: `width: 100vw; height: 100vh; scroll-snap-align: start;` per slide.
**Key techniques**:
- `scroll-snap-type: y mandatory;` on body
- Arrow key / scroll navigation; progress dots
- `<aside class="notes">` for speaker-only content (150-300 words per slide)
- Press `S` to open presenter view (BroadcastChannel). Full spec: `references/presenter-mode.md`

### 6. Interactive Explainer
**Definition**: A long-form article layout enhanced with collapsible deep-dives, tabbed code samples, and inline interactive demos.
**Structure**: Article layout with `<details>`, tabbed code, margin glossary.
**Key techniques**:
- TL;DR box at top (highlighted background)
- Collapsible `<details>` elements for deep dives
- Tabbed code samples (language switcher)
- Margin glossary with hover-linked terms

### 7. Status / Incident Report
**Definition**: A structured update page showing health metrics, timeline events, risk levels, and follow-up items with color-coded severity.
**Structure**: Header meta → timeline/chart → risk table → follow-ups.
**Key techniques**:
- Health pills: `on-track` (olive), `at-risk` (clay), `blocked` (rust)
- Mini bar charts with CSS flex heights
- Timeline: vertical line with colored dots and event cards

### 8. Flowchart / Process Diagram
**Definition**: An SVG-based decision tree or workflow diagram with clickable nodes that reveal detail panels.
**Structure**: SVG flowchart with clickable nodes and detail sidebar.
**Key techniques**:
- Nodes: `rect` (process), diamond `path` (decision), `circle` (start/end)
- Edges: `path` with optional dasharray for conditional flows
- Click node → show details in adjacent panel

### 9. SVG Illustration Sheet
**Definition**: A gallery of self-contained inline SVG figures with captions, designed for reuse or export.
**Structure**: Grid of `<svg viewBox>` figures with captions.
**Key techniques**:
- Each figure: self-contained with reusable CSS classes
- Export-ready: copy SVG code directly

### 10. Custom Editor / Triage Board
**Definition**: An interactive sorting, editing, or configuration interface with drag-and-drop, toggles, live preview, and export.
**Structure**: Interactive UI with drag-and-drop or form controls + export.
**Key techniques**:
- HTML5 Drag API for reordering
- CSS-only toggle switches
- Live preview panels; sticky toolbar; export to JSON/markdown

### 11. Dashboard / Data Display
**Definition**: A card-grid metrics view with large numbers, mini charts, status indicators, and color-coded KPIs.
**Structure**: Card grid with numbers + delta + sparkline + status.
**Key techniques**:
- Metric cards: big number + delta + CSS-only mini chart
- Color coding: olive (good), clay (warning), rust (bad)

### 12. Live Artifact / Refreshable Dashboard
**Definition**: A data-backed dashboard where template and data are separated, enabling refresh without regenerating the entire artifact.
**Structure**: `template.html` + inline data or `data.json` + refresh mechanism.
**Key techniques**:
- JavaScript data injection from inline JSON or fetch
- Auto-refresh: `setInterval(() => location.reload(), 60000)` or manual refresh button
- CSS charts or SVG that bind to data dynamically

### 13. Frame Effects / Visual Moments
**Definition**: A targeted, dramatic CSS animation applied to a specific section (hero, title reveal) for one memorable page moment.
**Structure**: One dramatic effect per page, placed strategically (typically hero).
**Key techniques**:
- Glitch titles: CSS keyframes + `clip-path`
- Liquid background: animated `border-radius` + `filter: blur()`
- Light leak: SVG gradient overlay with `mix-blend-mode: screen`
- Always respect `prefers-reduced-motion`; use `will-change` sparingly

---

## HTML Structure Template

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><!-- Descriptive title --></title>
<style>
  :root {
    --bg: #fafaf7; --surface: #ffffff; --fg: #1a1916;
    --muted: #6b6964; --border: #e8e5df; --accent: #c96442;
    --accent-soft: color-mix(in oklch, var(--accent) 14%, transparent);
    --fg-soft: color-mix(in oklch, var(--fg) 6%, transparent);
    --font-display: 'Iowan Old Style', 'Charter', Georgia, serif;
    --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --font-mono: ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, monospace;
    --fs-h1: clamp(44px, 6vw, 76px); --fs-h2: clamp(32px, 4vw, 48px);
    --fs-h3: 22px; --fs-lead: 19px; --fs-body: 16px; --fs-meta: 13px;
    --gap-xs: 8px; --gap-sm: 12px; --gap-md: 20px;
    --gap-lg: 32px; --gap-xl: 56px; --gap-2xl: 96px;
    --container: 1120px; --gutter: 32px;
    --radius: 10px; --radius-lg: 16px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; font-family: var(--font-body); background: var(--bg);
    color: var(--fg); line-height: 1.55;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    padding: 56px 24px 96px;
  }
  .container { max-width: var(--container); margin-inline: auto; padding-inline: var(--gutter); }
  .page { max-width: 980px; margin: 0 auto; }
</style>
</head>
<body>
<div class="page">
  <header>...</header>
</div>
<script>/* minimal interaction */</script>
</body>
</html>
```

---

## State Coverage · 状态覆盖

Every interactive surface must render all 5 required states.

| State | Must contain |
|---|---|
| **Loading** | Skeleton/spinner/shell + 15s "taking longer" fallback |
| **Empty** | Headline, plain explanation, primary CTA |
| **Error** | Plain-language cause, recovery action, preserved user input |
| **Populated** | The state the design was drawn for |
| **Edge** | Layout that does not break at extremes |

### Loading Duration → Indicator

| Duration | Indicator |
|---|---|
| 0–300ms | None (render synchronously) |
| 300ms–2s | Subtle spinner or skeleton |
| 2–10s | Skeleton matched to expected layout |
| 10–30s | Determinate progress bar with cancel |
| 30–60s | Progress bar + "Taking longer" at 15s |
| 60s+ | Stop animation. Show error with retry/cancel |

**Never leave a spinner running indefinitely.**

---

## Form Validation · 表单验证

### Input State Machine

| State | Meaning | UI |
|---|---|---|
| `pristine` | Not yet interacted | No chrome |
| `dirty` | Typed but not committed | No chrome yet |
| `touched` | Blurred at least once after editing | Field-level constraint runs |
| `invalid-after-touched` | Constraint failed after blur | Show error, `aria-describedby` |
| `invalid-after-submit` | Submit attempted, field invalid | Focus to summary/first invalid |
| `recovering` | Editing already-invalid field | Re-validate on `input`, not blur |
| `submitting` | Action in flight | Disable submit, polite live region |
| `server-error` | Server returned error | Use server's message text |

### Validation Timing (4 Rules)

1. **First blur after edit** runs field-level constraint. NOT on focus, NOT on first keystroke.
2. **Once invalid, switch to `input`-event re-validation** so error clears when input becomes valid.
3. **On submit**, run schema parse. Move focus to error summary or first invalid.
4. **Async checks split**: Background preflight debounces 250-500ms; authoritative on submit.

### CSS Shortcut

Style off `:user-invalid`, NOT `:invalid`. `:user-invalid` matches only after user has submitted or blurred with bad input (Baseline since Chrome 119, Firefox 88, Safari 16.5).

---

## Quality Checklist

Run before emitting `<artifact>`. P0 = must pass; P1 = should pass; P2 = nice to have.

### P0 — Must Pass (15 items)

- [ ] **No raw hex outside `:root` token block.** Every color is `var()` or `color-mix()` of the 6 tokens.
- [ ] **All headings use `var(--font-display)`.** No sans-serif `<h1>`/`<h2>`.
- [ ] **Accent appears at most twice per visual region.** Count: eyebrow, CTA, anything else? Demote if ≥3.
- [ ] **No purple/violet/indigo gradient backgrounds.** No `linear-gradient(... #a855f7 / #8b5cf6 ...)`.
- [ ] **No emoji as feature icons.** Use inline SVG monoline marks.
- [ ] **No invented metrics.** Every number from user/brief or labelled as placeholder.
- [ ] **No filler copy.** Zero "Feature One / Feature Two", lorem ipsum.
- [ ] **`data-od-id` on every top-level `<section>`.**
- [ ] **Mobile reflow works.** All grids collapse to one column at ≤920px. No horizontal scroll.
- [ ] **No `scrollIntoView()` calls.** Use `scrollTo({...})` if scroll behavior needed.
- [ ] **ALL CAPS have `letter-spacing` ≥ `0.06em`.**
- [ ] **Display text (≥32px) has negative tracking** (`-0.01em` to `-0.03em`).
- [ ] **Display text uses `var(--font-display)`**, not system-sans.
- [ ] **No rounded card + colored left-border accent** on the same element.
- [ ] **Style off `:user-invalid`, not `:invalid`.**

### P1 — Should Pass (10 items)

- [ ] **One decisive flourish.** One memorable moment, not three.
- [ ] **Section rhythm alternates.** No two stat rows / quote blocks / feature triplets in a row.
- [ ] **Headlines under 14 words.** If longer, the writing is doing the design's job.
- [ ] **Lead text under 56 ch / two sentences.** `max-width: 60ch` on `.lead`.
- [ ] **CTA buttons say what happens.** "Start free" beats "Get Started".
- [ ] **Hover states present** for all `<a>` and `.btn`.
- [ ] **Numerics use `.num` (mono, tabular).** Prices, stats, version numbers.
- [ ] **One image style per page.** Don't mix square portraits with widescreen heroes.
- [ ] **No external placeholder image CDNs** (`unsplash.com`, `placehold.co`).
- [ ] **No `outline: none` without `:focus-visible` replacement.**

### P2 — Nice to Have

- [ ] **`text-wrap: pretty`/`balance`** on long paragraphs/headings.
- [ ] **`color-mix()` for derived tones.** No additional `--accent-50`/`--accent-300` tokens.
- [ ] **Sticky topnav has frosted glass** via `backdrop-filter: blur()`.
- [ ] **Loaded fonts are system-first.** Only pull a Google Font if design system specifies one.

---

## 5-Dimension Self-Critique

Before emitting, run a structured self-critique. **Each dimension scored 0-10 with specific evidence cited.**

### Scoring Bands

| Score | Band | Description |
|-------|------|-------------|
| 0-4 | **Broken** | Fundamental issues that break the experience |
| 5-6 | **Functional** | Works but lacks polish or consistency |
| 7-8 | **Strong** | Competent, polished, intentional |
| 9-10 | **Exceptional** | Memorable, magazine-grade |

### Dimensions

**1. Philosophy Consistency** — One declared direction, no style drift. *(Was: Visual Hierarchy in v2.1)*
- **0-4**: Three or more competing styles. User can't identify the aesthetic direction.
- **9-10**: Every element argues for the same thesis. Unmistakable direction.

**2. Visual Hierarchy** — Can a stranger figure out what to read first, second, third? *(Was: Responsive in v2.1)*
- **0-4**: Everything shouts. No clear reading order.
- **9-10**: Eye moves with zero friction. Obvious what matters.

**3. Detail Execution** — Alignment, leading, kerning, edge-case spacing. *(Was: Interaction in v2.1)*
- **0-4**: Visible tape and string. Misaligned elements, inconsistent spacing.
- **9-10**: Magazine-grade. Pixel-perfect execution.

**4. Functionality** — Does it WORK? Keyboard nav, click targets, responsive behavior. *(Was: Performance in v2.1)*
- **0-4**: Visually fine but doesn't accomplish its job. Broken interactions.
- **9-10**: Defensively engineered. Graceful degradation, bulletproof.

**5. Innovation** — One unexpected move that makes people lean in. *(Was: Accessibility in v2.1)*
- **0-4**: Generic AI-slop median. Inter font, purple gradient, stock layout.
- **9-10**: Multiple moves you'd steal. Pushes past median decisively.

### Scoring Discipline Rules

1. **Always cite evidence** — specific class names, line numbers, or elements.
2. **Don't average up** — score the WORST sustained band. If Philosophy=9 but Detail=4, overall is Broken until fixed.
3. **Don't grade-inflate** — a 7 means STRONG, not "acceptable". Be honest.
4. **Innovation can be low** — 5/10 for production work is fine. Utility matters.
5. **Separate intent from execution** — maximalist design with poor execution scores low on Detail even if Philosophy is bold.

### Output Format

```
## Self-Critique Report
### Scores
- Philosophy Consistency: X/10 (Band)
- Visual Hierarchy: X/10 (Band)
- Detail Execution: X/10 (Band)
- Functionality: X/10 (Band)
- Innovation: X/10 (Band)

### Keep (3-5 bullets)
### Fix (3-6 bullets, P0/P1 ordered)
### Quick Wins (3-5 bullets)
```

---

## DevLoop: Iterative Refinement

1. **Generate** → first version of the artifact
2. **Critique** → run 5-dimension self-critique
3. **Check** → if ANY dimension < 4 (Broken), iterate
4. **Fix** → fix the lowest-scoring dimension first
5. **Re-critique** → score again
6. **Repeat** → max 3 iterations total

**Escape hatch**: User says "good enough" / "stop iterating" / "emit it".

**Skip DevLoop if**: All dimensions ≥ 7, or user says "rough"/"draft"/"quick".

---

## Decision Flow

**Scope**: This Skill is for pure front-end presentation artifacts only. Not suitable for auth/payment/backend logic/real-time database scenarios — refuse and inform user when such requirements arise.

1. **What is the purpose?** → Map to Pattern Catalog (1-13). **If needs span multiple patterns**, pick the closest primary pattern as page skeleton, embed auxiliary patterns at section level.
2. **What is the tone?** → Choose aesthetic direction (minimal, maximalist, retro, etc.)
3. **Tuning knobs?** → Apply VARIANCE / MOTION / DENSITY if user specified
4. **What is the density?** → Choose max-width (860px dense, 1180px spacious)
5. **Does it need interaction?** → Add minimal JS
6. **Is there data to visualize?** → CSS charts or SVG diagrams
7. **Does it need refresh/sync?** → Pattern #12: template + data
8. **Is it a presentation?** → Pattern #5: scroll-snap + `<aside class="notes">`
9. **Does it need visual impact?** → Pattern #13: one dramatic moment
10. **Run critique** → Score 5 dimensions, iterate if < 4

## Section Rhythm Guide

| Page kind | Default rhythm |
|---|---|
| Landing | hero → features → stats *or* quote → split detail → cta |
| Marketing / editorial | hero-center → log list → cta |
| Pricing | hero-center → comparison table → cta |
| Dashboard | KPI row → primary chart → secondary chart/table |
| Presentation | cover → toc → section-divider → [2-4 body] → cta → thanks |

**Rules**: No two stat rows / quote blocks / feature triplets in a row. Alternate airy → dense → airy. Max one Frame Effect per page.

---

## Chinese-Friendly Notes (中文说明)

- **字体**: 中文使用 `Noto Sans SC`, `PingFang SC`, `Microsoft YaHei` 等系统字体
- **排版**: 中文段落 `text-wrap: pretty`, 标题 `text-wrap: balance`
- **色彩**: 保持 6 token 约束，中文场景可使用更温暖的调色板
- **演示模式**: Pattern #5 支持中文演讲者备注（`<aside class="notes">`）

```css
--font-display-cn: 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
--font-body-cn: 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', sans-serif;
```

---

## Output Contract

```
<artifact identifier="kebab-case-slug" type="text/html" title="Human Title">
<!doctype html>
<html>...</html>
</artifact>
```

For critique reports: `<artifact identifier="critique-[slug]" ...>`

For live artifacts (template + data): Second `<file path="data.json">` after the artifact.

One sentence before the artifact. Nothing after `</artifact>`.

---

## Version History

- **v3.0** (2026-06-29): Craft Discipline Revolution. 7 craft rules + state coverage + form validation. SKILL.md restructured (1421→~400 lines). 6 new references files. P0→15 items, P1→10 items. Tuning knobs (VARIANCE/MOTION/DENSITY). Brand anchors for aesthetics. Accent discipline per visual region. Animation decision tree. WCAG 2.2 AA target. One-memory rule.
- **v2.1** (2026-05-21): 5-dimension critique + DevLoop. Patterns #12 (Live Artifact) and #13 (Frame Effects). Enhanced Pattern #5 (36 themes, Canvas FX).
- **v2.0** (2026-05-20): Combined html-effectiveness + frontend-design + open-design. 6-token design system, 11 patterns, P0/P1/P2 quality system.
- **v1.0** (2026-05): Initial release based on html-effectiveness.
*（内容由AI生成，仅供参考）*
