# HTML Effectiveness v3.0 Release Notes

**Release Date**: 2026-05-21
**Theme**: Craft Discipline Revolution

---

## Overview

v3.0 integrates the full **craft discipline system** from OpenDesign into html-skill-effectiveness. Seven enforceable craft rule files — each grounded in primary research and designed for lintability — are now embedded directly in SKILL.md, giving the AI the same checkable constraints a human designer uses after shipping product.

## What Changed

### New: Craft Rules Chapter (19KB)

Seven sub-sections, each with P0 rules and evidence citations:

| # | Craft Rule | Source | Key Contribution |
|---|---|---|---|
| 1 | **Anti-AI-Slop** | `anti-ai-slop.md` | 7 cardinal sins + soul formula (80/20) |
| 2 | **Color** | `color.md` | 4-layer palette structure + accent cap (2/screen) |
| 3 | **Typography** | `typography.md` | Letter-spacing rules + 3-weight system |
| 4 | **Typography Hierarchy** | `typography-hierarchy.md` | 5 hierarchy vectors + 3-level working model |
| 5 | **Animation Discipline** | `animation-discipline.md` | Duration thresholds + curve vs spring + 3 myth corrections |
| 6 | **Accessibility Baseline** | `accessibility-baseline.md` | WCAG legal floor by jurisdiction + ARIA discipline |
| 7 | **Laws of UX** | `laws-of-ux.md` | 26 actionable heuristics from primary research |

### New: State Coverage Chapter

- 5 required UI states (Loading/Empty/Error/Populated/Edge)
- Loading duration → indicator mapping table
- Empty state composition rules (4 types)
- Error state 3-question protocol
- ARIA and focus rules for state changes

### New: Form Validation Chapter

- 8-state input state machine
- 4 validation timing rules
- CSS `:user-invalid` shortcut
- Error wiring patterns (inline + summary)

### Enhanced: P0 Anti-Patterns (10→15 items)

New items:
1. ALL CAPS without `letter-spacing` ≥ `0.06em`
2. Display text (≥32px) without negative tracking
3. Sans-serif on display text when `:root` binds serif
4. Rounded card + colored left-border accent
5. Styling off `:invalid` instead of `:user-invalid`

### Enhanced: P1 Anti-Patterns (+6 items)

New items:
1. Standard Hero→Features→Pricing→FAQ→CTA without variation
2. External placeholder image CDNs
3. `var(--accent)` used 6+ times (cap: 2 visible/screen)
4. Decorative animation (not for spatial/temporal/state transition)
5. `outline: none` without replacement
6. Validate on first keystroke (should be on first blur)

## Research Sources

This release is grounded in primary sources, not hearsay:

- **Animation**: Tversky/Morrison/Bétrancourt 2002 (IJHCS 57), Material 3 motion tokens, IBM Carbon Motion, Apple SwiftUI Animation API
- **Typography**: Bringhurst *Elements of Typographic Style* §3.2.7
- **Accessibility**: WCAG 2.2, ADA Title II 2024, EN 301 549 v3.2.1, WebAIM Million 2026, ARIA APG
- **UX Laws**: Hick 1952, Miller 1956, Cowan 2001, Fitts 1954, Wertheimer 1923, Kahneman 1993, Csíkszentmihályi 1975
- **Forms**: WHATWG HTML Living Standard, Baymard 2024 checkout-UX benchmark, Standard Schema spec

## Myth Corrections

Three widely-believed design myths are corrected with primary source evidence:

1. **"Skeleton screens feel 11% faster"** — FALSE. Harrison/Yeo/Hudson CHI 2010 measured *backwards-decelerating ribbed determinate progress bars*, not skeletons.
2. **"Doherty Threshold = 400ms"** — FALSE. The 1982 paper does not contain "400". Lowest measured threshold = 300ms.
3. **"M2 standard easing = M3 standard easing"** — FALSE. M3 standard is `cubic-bezier(0.2,0,0,1)`. M2's `cubic-bezier(0.4,0,0.2,1)` is preserved in M3 under the name `legacy`.

## Breaking Changes

None. All v2.1 features are preserved. Craft Rules are additive constraints.

## Migration from v2.1

- **P0 checklist**: Expand from 10 to 15 items. All new items are checkable constraints.
- **P1 checklist**: Add 6 new items.
- **Workflow**: Add Craft Rules pass before Pattern Catalog selection.
- **Quality**: Craft Rules score feeds into 5-Dimension Self-Critique (especially Detail Execution and Functionality dimensions).

## File Changes

| File | Change | Size |
|---|---|---|
| `SKILL.md` | Added Craft Rules + State Coverage + Form Validation chapters; enhanced P0/P1 | 42KB → 63KB |
| `README.md` | Updated v3.0 features; enhanced Quality Standards; updated Credits | 12KB |
| `BLOG.md` | Added v3.0 blog section | Updated |
| `INTEGRATION_SUMMARY.md` | Added v3.0 integration analysis | Updated |
| `RELEASE-v3.0.md` | New file | This file |
| `references/craft-rules-reference.md` | New quick reference | New |

## Credits

- **Craft Rules**: [open-design](https://github.com/opendesign) by OpenDesign
- **Research Sources**: See Research Sources section above
- **Previous Versions**: v2.1 Critique Revolution, v2.0 Design System, v1.0 html-effectiveness
- **Integration**: [Yardon](https://github.com/YardonYan)
