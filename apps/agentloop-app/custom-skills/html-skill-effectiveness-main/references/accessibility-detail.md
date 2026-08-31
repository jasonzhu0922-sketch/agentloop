---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 263ae02d9b82b898f7b6446bc49bf3dd_d2f8454773c711f1b2f55254006c9bbf
    ReservedCode1: PpCO8nvzdrv+qnMDp7b0AkNsGGgiJdr+i36Vxzlpq8v2uvA6qmCOEA/FI0EUi0mJv2hi/HbPGHfQxiyRpghX+lKdPhzmFF9Dv7l6aaUCLfNZi8Pwu+994f6QfpdmiY9giebYQhdkZxKbUxJT9clgUCwk2cGfHGwviCHHbfW33w4hmoP1c7iFMRG0VDE=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 263ae02d9b82b898f7b6446bc49bf3dd_d2f8454773c711f1b2f55254006c9bbf
    ReservedCode2: PpCO8nvzdrv+qnMDp7b0AkNsGGgiJdr+i36Vxzlpq8v2uvA6qmCOEA/FI0EUi0mJv2hi/HbPGHfQxiyRpghX+lKdPhzmFF9Dv7l6aaUCLfNZi8Pwu+994f6QfpdmiY9giebYQhdkZxKbUxJT9clgUCwk2cGfHGwviCHHbfW33w4hmoP1c7iFMRG0VDE=
---

# Accessibility Detail · WCAG 合规细节

从 SKILL.md Craft Rule 6 迁移并扩展的完整 WCAG 合规参考。核心 Skill 目标 WCAG 2.2 AA，详细司法管辖区合规内容见本文档。

---

## Jurisdiction Comparison / 司法管辖区对比

| Jurisdiction / 司法管辖区 | Standard / 标准 | Reference / 引用 | Enforcement / 执行 |
|---|---|---|---|
| **EU (EAA)** | WCAG 2.1 AA | EN 301 549 v3.2.1 | Live 2025-06-28 |
| **US Public Sector (ADA Title II 2024)** | WCAG 2.1 AA | 2027-04-26 (≥50k pop.), 2028-04-26 (sub-50k) | Phased rollout |
| **US Federal Procurement (Section 508)** | WCAG 2.0 AA | Revised 508 Standards | Update in flight |
| **US Private Sector (ADA Title III)** | WCAG 2.1 AA (de facto) | No federal technical standard | Case-by-case |
| **Canada (ACA)** | WCAG 2.0 AA | Standard on Web Accessibility | Active |
| **UK (Equality Act 2010)** | WCAG 2.1 AA | BS 8878 / ISO 30071-1 | Active |
| **Australia (DDA)** | WCAG 2.0 AA | Disability Discrimination Act | Active |
| **Japan (JIS X 8341-3)** | WCAG 2.0 AA | JIS X 8341-3:2016 | Active |

**Practical rule**: target **WCAG 2.2 AA** as working ceiling. Clears WCAG 2.1 AA legal floor in both EU and US jurisdictions.

---

## WCAG 2.1 AA Key Checkpoints / WCAG 2.1 AA 关键检查项

### Perceivable / 可感知

| SC | Requirement / 要求 | Check / 检查 |
|----|-----------|-------|
| 1.1.1 | Non-text Content — alt text for all images | Every `<img>` has `alt` (empty for decorative) |
| 1.3.1 | Info and Relationships — semantic HTML | `<header>`, `<nav>`, `<main>`, `<section>`, `<h1>`-`<h6>` hierarchy |
| 1.3.2 | Meaningful Sequence — correct DOM order | Visual order matches DOM order |
| 1.4.1 | Use of Color — not color-only | Add icons/text alongside color-coded status |
| 1.4.3 | Contrast (Minimum) — 4.5:1 normal, 3:1 large | Test all text/background pairs |
| 1.4.4 | Resize Text — 200% without loss | Zoom test at 200% |
| 1.4.5 | Images of Text — use text, not images | No text-in-images unless essential (logos) |
| 1.4.10 | Reflow — 320px wide without scroll | Single-column at ≤320px |
| 1.4.11 | Non-text Contrast — 3:1 for UI components | Test focus rings, borders, icons |
| 1.4.13 | Content on Hover or Focus — dismissable | Tooltips dismissable without moving pointer |

### Operable / 可操作

| SC | Requirement / 要求 | Check / 检查 |
|----|-----------|-------|
| 2.1.1 | Keyboard — all functionality keyboard-accessible | Tab through entire page |
| 2.1.2 | No Keyboard Trap | No element traps focus |
| 2.3.1 | Three Flashes or Below Threshold | No flashing > 3/sec |
| 2.4.3 | Focus Order — meaningful sequence | Tab order matches visual order |
| 2.4.7 | Focus Visible — visible focus indicator | All interactive elements show focus ring |
| 2.5.8 | Target Size (Minimum) — 24×24 CSS px | All clickable targets ≥ 24×24px (with exceptions) |

### Understandable / 可理解

| SC | Requirement / 要求 | Check / 检查 |
|----|-----------|-------|
| 3.2.1 | On Focus — no context change | Focusing element doesn't auto-submit/redirect |
| 3.2.2 | On Input — no context change without warning | Changing input doesn't auto-submit/redirect |
| 3.3.1 | Error Identification — describe errors in text | Error messages describe what's wrong |
| 3.3.2 | Labels or Instructions — label all inputs | Every input has `<label>` with `for` attribute |

### Robust / 健壮

| SC | Requirement / 要求 | Check / 检查 |
|----|-----------|-------|
| 4.1.1 | Parsing — no major markup errors | Valid HTML |
| 4.1.2 | Name, Role, Value — proper ARIA if needed | Custom widgets expose name/role/value |

---

## WCAG 2.2 AA Additions / WCAG 2.2 AA 新增项

| SC | Requirement |
|----|-----------|
| 2.4.11 | Focus Not Obscured (Minimum) — focused item not entirely hidden |
| 2.4.13 | Focus Appearance — focus indicator meets minimum area and contrast |
| 2.5.7 | Dragging Movements — alternative to dragging (e.g., click to select) |
| 2.5.8 | Target Size (Minimum) — 24×24px (moved from 2.1) |
| 3.2.6 | Consistent Help — help mechanism in same relative order |
| 3.3.7 | Accessible Authentication — no cognitive function test |
| 3.3.9 | Redundant Entry — previously entered info auto-populated or available |

---

## ARIA Role Usage Guide / ARIA 角色使用指南

### Decision Order (ARIA APG)

1. **Native HTML** element with right semantics — always preferred.
2. **Native element** under custom visuals if restyling required.
3. **APG pattern** verbatim if neither fits.
4. **Closest APG pattern** + documented deviation. **Last resort.**

### Commonly Used Roles

| Role | Use When | HTML Alternative |
|------|----------|-----------------|
| `role="alert"` | Inline error on submit (interrupts SR) | — |
| `role="status"` | Non-urgent confirmation (polite) | — |
| `role="alertdialog"` | Critical error / destructive confirm | — |
| `role="navigation"` | Custom nav (prefer `<nav>`) | `<nav>` |
| `role="tablist"` / `role="tab"` / `role="tabpanel"` | Tabbed interface | — |
| `role="dialog"` | Custom modal | `<dialog>` element |
| `role="presentation"` | Remove semantics from layout elements | — |

### Key Rules

- **Never invent ARIA.** Use only patterns from ARIA APG.
- `aria-describedby` is the production default for linking error messages.
- `aria-errormessage` has incomplete SR support (full NVDA, partial JAWS/VoiceOver/TalkBack).
- Bare `<a>` without `href` is NOT a link — use `<button>` for actions.

---

## Common Anti-Patterns / 常见反模式

| Anti-Pattern | Why Wrong | Fix |
|---|---|---|
| `outline: none` without replacement | Triple failure (1.4.11 / 2.4.7 / 2.4.13) | Use `:focus-visible` + custom ring |
| "Target Size 44×44" cited as AA bar | 44×44 is AAA (2.5.5), AA is 24×24 (2.5.8) | Check correct SC number |
| "18px = large text" for contrast | Threshold is 18**pt** (~24px) regular | Use 24px as threshold |
| ARIA on native elements | WebAIM Million: ARIA pages avg 59.1 errors vs 42 non-ARIA | Use native HTML first |
| `role="alert"` + `tabindex="-1"` on same element | Double-announcement | Pick one: moved focus OR alert, not both |
| Missing `<label>` on inputs | Screen reader can't identify field purpose | Always pair `<label for="...">` with input |
| Color-only status indicators | Color-blind users miss information | Add icon or text alongside color |
| Skip-link missing | Keyboard users must tab through entire nav | Add skip-to-main-content link |
*（内容由AI生成，仅供参考）*
