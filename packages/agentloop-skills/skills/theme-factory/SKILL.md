---
name: theme-factory
description: Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly.
license: Complete terms in LICENSE.txt
agentloop:
  roles:
    - support
  artifactKinds:
    - html
    - document
    - presentation
    - spreadsheet
    - image
    - code
  sourceKinds: []
  qaKinds: []
---


# Theme Factory Skill

This skill provides a curated collection of professional font and color themes themes, each with carefully selected color palettes and font pairings. Once a theme is chosen, it can be applied to any artifact.

## Purpose

To apply consistent, professional styling to presentation slide decks, use this skill. Each theme includes:
- A cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- A distinct visual identity suitable for different contexts and audiences

## Usage Instructions

To apply styling to a slide deck or other artifact:

1. **Show the theme showcase**: Make `theme-showcase.pdf` available for the user to inspect. Do not modify it.
2. **Persist the choice as HIL**: Before applying a theme or creating a themed final artifact, call `request_human_loop`; a sentence in assistant output such as “please confirm” or “choose a theme” is never a substitute. This is a stop gate: do not apply a palette/font pairing, write the final deck/artifact, or claim delivery until the HIL response is received.
3. **Use a typed selection request for packaged themes**: use `kind: "selection"`, `responseSchema.type: "select"`, one required selection, and an option for every applicable packaged theme. Each option must name the theme and summarize its palette, typography, and practical tradeoff. Bind the showcase or theme-definition tool-result references in `evidenceRefs`, and use `resume.mode: "continue_step"`.
4. **Apply the selected theme**: After the response, read only the corresponding theme definition and apply its colors and fonts consistently throughout the deck/artifact.

Never infer a selection from a user silence, from a model preference, or from a sector convention. If the user has already explicitly named one of the packaged themes, that selection is authoritative and no selection HIL is needed.

## Themes Available

The following 10 themes are available, each showcased in `theme-showcase.pdf`:

1. **Ocean Depths** - Professional and calming maritime theme
2. **Sunset Boulevard** - Warm and vibrant sunset colors
3. **Forest Canopy** - Natural and grounded earth tones
4. **Modern Minimalist** - Clean and contemporary grayscale
5. **Golden Hour** - Rich and warm autumnal palette
6. **Arctic Frost** - Cool and crisp winter-inspired theme
7. **Desert Rose** - Soft and sophisticated dusty tones
8. **Tech Innovation** - Bold and modern tech aesthetic
9. **Botanical Garden** - Fresh and organic garden colors
10. **Midnight Galaxy** - Dramatic and cosmic deep tones

## Theme Details

Each theme is defined in the `themes/` directory with complete specifications including:
- Cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- Distinct visual identity suitable for different contexts and audiences

## Application Process

After a preferred theme is selected:
1. Read the corresponding theme file from the `themes/` directory
2. Apply the specified colors and fonts consistently throughout the deck
3. Ensure proper contrast and readability
4. Maintain the theme's visual identity across all slides

## Create your Own Theme

To handle cases where none of the existing themes work for an artifact, create a custom theme. Based on provided inputs, generate a new theme similar to the ones above. Give the theme a similar name describing what the font/color combinations represent. Use any basic description provided to choose appropriate colors/fonts.

After producing the custom theme specification, request its approval with `request_human_loop` before applying it or creating the themed final artifact. Use `kind: "confirmation"`, `responseSchema.type: "confirm"`, `resume.mode: "continue_step"`, and bind the custom-theme specification result in `evidenceRefs`. The confirmation prompt must identify the proposed name, palette, and fonts. Do not render “please confirm” as ordinary assistant prose and then continue as if it were a HIL. On acceptance, apply that exact approved specification; on rejection, use the rejection feedback to revise the theme and request a new confirmation rather than silently substituting another theme.
