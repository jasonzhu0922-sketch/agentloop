# Craft Rules Quick Reference · 工艺规则快速参考

A condensed, checkable reference for all craft rules. Use as a pre-flight checklist before emitting any artifact.

---

## 1. Anti-AI-Slop Checklist

- [ ] No default Tailwind indigo (`#6366f1`, `#8b5cf6`, `#a855f7`) as accent
- [ ] No two-stop "trust" gradient on hero (purple→blue, blue→cyan)
- [ ] No emoji as feature icons (use monoline SVG with `currentColor`)
- [ ] Display text uses `var(--font-display)`, not system-sans
- [ ] No rounded card + colored left-border accent combo
- [ ] No invented metrics without source
- [ ] No filler copy ("Feature One", "lorem ipsum")
- [ ] Soul formula: 80% proven + 20% distinctive (one bold move, voice, micro-interaction, product detail)

## 2. Color Checklist

- [ ] 4-layer palette planned: Neutrals (70-90%), Accent (5-10%), Semantic (0-5%), Effect (<1%)
- [ ] One accent only. Never invent a second accent.
- [ ] Accent appears ≤2 times per screen (count: eyebrows, CTAs, links, focus rings)
- [ ] Contrast: body text 4.5:1, large text 3:1, UI components 3:1
- [ ] Dark theme: no pure black (`#000`) or white (`#fff`); use `#0f0f0f` / `#f0f0f0`
- [ ] No raw hex outside `:root` (cap ~12 raw hex)

## 3. Typography Checklist

- [ ] Type scale: multiplicative (1.2 or 1.25), cap 6-8 sizes
- [ ] Line height: Display/H1 1.0-1.2, Body 1.5-1.6, Small 1.5
- [ ] Letter-spacing: Body `0`, Small `0.01-0.02em`, UI labels `0.02em`, **ALL CAPS `0.06-0.1em`**, Headings 32px+ `-0.01-0.02em`, Display 48px+ `-0.02-0.03em`
- [ ] Font pairing: max 2 typefaces, always declare fallback chain
- [ ] Line length: body ≤75 chars (`max-width: 65ch`)
- [ ] 3-weight system: Read (400), Emphasize (550), Announce (600)

## 4. Typography Hierarchy Checklist

- [ ] One dominant entry point per visual region
- [ ] At least 2 hierarchy vectors active on dominant element (Scale/Weight/Spacing/Tracking/Alignment)
- [ ] No flat hierarchy: scale steps ≥1.25× apart OR compensated by weight/spacing jump
- [ ] No noise hierarchy: ≤1 primary element above the fold
- [ ] Spacing between levels varies (at least one gap ≥1.5× others)
- [ ] No graduated weight ladder (regular→medium→semibold→bold→extrabold)

## 5. Animation Discipline Checklist

- [ ] Animation is for spatial/temporal/state transition ONLY (not teaching/decorating)
- [ ] Default duration: 150ms for state-confirmation
- [ ] Non-cross-screen transitions: ≤500ms
- [ ] Curve for opacity/color/scale; Spring for position/rotation/physical
- [ ] M3 standard easing: `cubic-bezier(0.2, 0, 0, 1)` (not M2's `0.4, 0, 0.2, 1`)
- [ ] `@media (prefers-reduced-motion: reduce)` strips translate/scale/rotate/parallax
- [ ] No >3 flashes/second (WCAG 2.3.1)
- [ ] Animation not sole signal of state change; pair with static affordance

## 6. Accessibility Baseline Checklist

- [ ] Target: WCAG 2.2 AA (clears WCAG 2.1 AA legal floor)
- [ ] `<html lang="...">` present
- [ ] Semantic landmarks: `<header>`, `<nav>`, `<main>`, `<aside>`, `<footer>`
- [ ] Touch targets: AA 24×24px (legal), AAA 44×44px (craft commitment)
- [ ] Focus: `:focus-visible` for keyboard, never `outline: none` without replacement
- [ ] ARIA: native elements first → native + custom visuals → APG pattern → last resort deviation
- [ ] Form labels: explicit `<label for="...">` + `aria-describedby` (not `aria-errormessage`)
- [ ] No bare `<a>` without `href` (not focusable, not keyboard-operable)
- [ ] Contrast ratios verified (4.5:1 body, 3:1 large text/UI)

## 7. Laws of UX Quick Reference

| Law | One-Line Rule |
|---|---|
| Proximity | Related items ≤8px apart; unrelated ≥24px |
| Similarity | Same type = same visual treatment |
| Prägnanz | Simpler arrangement wins |
| Figure-Ground | Active element pops in grayscale test |
| Focal Point | ONE dominant per screen |
| Common Region | Box/background = group |
| Hick's Law | >7 options → search/filter/group into 3-5 |
| Choice Overload | Primary actions ≤3 |
| Pareto | Make 20% prominent, bury 80% |
| Miller/Cowan | Working memory: 4±1 items per chunk |
| Peak-End | Make peak and exit deliberate |
| Zeigarnik | Show progress for multi-step |
| Fitts's Law | Primary actions ≥44px, near cursor |
| Jakob's Law | Match familiar patterns first, innovate after |
| Goal Gradient | Show progress, celebrate milestones |

## 8. State Coverage Checklist

- [ ] Loading state: skeleton/spinner + 15s fallback
- [ ] Empty state: headline + explanation + CTA (not blank)
- [ ] Error state: what happened + why + what to do (preserve user input)
- [ ] Populated state: the one you actually designed
- [ ] Edge state: long strings, missing fields, RTL, extreme volume
- [ ] Spinner has timeout (60s max → show error with retry)
- [ ] ARIA: `role="alert"` for inline errors, `role="status"` for loading/toast, `role="alertdialog"` for critical

## 9. Form Validation Checklist

- [ ] Validate on first blur after edit, NOT on first keystroke
- [ ] Once invalid, re-validate on `input` event (clears error immediately)
- [ ] Style off `:user-invalid`, NOT `:invalid`
- [ ] Error summary at form top on submit (with `tabindex="-1"`, NOT `role="alert"`)
- [ ] Inline per-field errors use `role="alert"` + `aria-describedby`
- [ ] Preserve user input on error (never clear form on submit failure)
- [ ] Adaptive error messages (specific subrule, not "Invalid input")
- [ ] Async checks: debounce 250-500ms; server validation on submit path awaits response
