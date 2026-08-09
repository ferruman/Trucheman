---
name: Book Translator
description: A focused command workbench for local book-translation jobs.
colors:
  canvas: "#0b0e14"
  surface: "#111722"
  surface-raised: "#171f2d"
  border: "#263041"
  text: "#e7edf5"
  text-muted: "#8b98aa"
  accent: "#59c2ff"
  accent-soft: "#10283a"
  accent-border: "#245c7d"
  success: "#66d9a3"
  success-soft: "#102a21"
  success-border: "#245c46"
  warning: "#e9b872"
  warning-soft: "#2c2415"
  warning-border: "#6b542e"
  danger: "#ff6b7a"
  danger-soft: "#2d141b"
  danger-border: "#6b2a35"
  danger-text: "#ffb4bd"
  modal-backdrop: "rgb(3 5 8 / 0.78)"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "clamp(1.5rem, 3vw, 2.25rem)"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.04em"
  data:
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
  subtitle:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  component-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
  table:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
  caption:
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.4
  micro:
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: "0.625rem"
    fontWeight: 400
    lineHeight: 1.2
rounded:
  control: "4px"
  panel: "6px"
  status: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.canvas}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "16px"
---

# Design System: Book Translator

## Overview

**Creative North Star: "The Command Workbench"**

Book Translator should feel like a precise local tool operated by one person, not a public SaaS dashboard and not a theatrical terminal simulation. Its visual language borrows the legibility, compactness, explicit state, and keyboard confidence of excellent command-line tools while preserving familiar web controls.

The interface is dark, quiet, and information-forward. Hierarchy comes from topology, labels, borders, and typographic contrast rather than cards, illustration, or ornamental effects.

**Key Characteristics:**

- One visible pipeline with current state and technical detail always nearby.
- Sans-serif prose paired with monospace labels, metrics, identifiers, and logs.
- Flat tonal layers, crisp borders, compact spacing, and restrained cyan emphasis.
- Controls use direct verbs and expose keyboard shortcuts where they are real.

## Colors

The palette is a matte midnight work surface with cool text and a single cyan interaction accent; semantic colors appear only for real status.

### Primary

- **Command Cyan** (`#59c2ff`): primary actions, active navigation, focus, and the current pipeline stage.

### Neutral

- **Midnight Canvas** (`#0b0e14`): application background and inset fields.
- **Workbench Surface** (`#111722`): primary panels and navigation.
- **Raised Instrument** (`#171f2d`): controls and selected secondary surfaces.
- **Circuit Border** (`#263041`): structure, separators, and table rules.
- **Cold White** (`#e7edf5`): primary text.
- **Slate Readout** (`#8b98aa`): secondary text and inactive metadata.

### Named Rules

**The One Signal Rule.** Cyan identifies interaction and current position; never scatter it as decoration.

## Typography

**Display Font:** system UI sans-serif
**Body Font:** system UI sans-serif
**Label/Mono Font:** SFMono-Regular, Consolas, Liberation Mono, monospace

**Character:** Human-readable prose stays neutral and compact. Monospace is reserved for operational language: status, commands, timestamps, identifiers, metrics, and logs.

### Hierarchy

- **Headline** (650, `clamp(1.5rem, 3vw, 2.25rem)`, 1.15): page and job identity.
- **Title** (600, `1rem`, 1.35): panel and section titles.
- **Body** (400, `0.9375rem`, 1.55): explanations and form content; keep long lines below 72 characters.
- **Label** (600, `0.75rem`, `0.04em`): compact controls and metadata, usually uppercase.
- **Data** (400, `0.8125rem`, 1.5): logs, metrics, file names, and machine state.
- **Micro** (400, `0.625rem`, 1.2): short pipeline substates only; never body copy.

**The Meaningful Mono Rule.** Use monospace because content behaves like data, never merely to make the interface look technical.

## Layout

Desktop uses a persistent command rail and a bounded work area. Job screens organize the pipeline, active-stage details, metrics, log, and actions in a clear grid without nesting every region inside a card. Spacing follows a 4/8/12/16/24/32px rhythm. At narrow widths the rail becomes a compact top bar, multi-column areas stack, and tables scroll horizontally without hiding columns.

## Elevation & Depth

The system is flat. Depth comes from three tonal layers and `1px` borders; it does not use box shadows, glow, glass, or gradients. Modal dialogs may use the raised surface against a dim backdrop but remain border-defined.

**The Flat Instrument Rule.** A region earns separation through function and tone, not decorative elevation.

## Shapes

Corners are precise but not severe: controls use `4px`, panels and dialogs use `6px`. Thin solid rules establish structure. Pills are reserved for compact status tokens whose shape helps distinguish them from actions.

## Components

### Buttons

- **Primary:** cyan fill, midnight text, `4px` radius, compact label typography.
- **Secondary:** raised surface with a circuit border and cold-white text.
- **Hover / Focus:** small tonal change; focus uses a visible cyan outline. No lift, glow, or playful motion.

### Cards / Containers

- **Corner Style:** restrained `6px` radius.
- **Background:** workbench or raised surface according to hierarchy.
- **Shadow Strategy:** none.
- **Border:** `1px solid #263041` where boundaries are not otherwise obvious.
- **Internal Padding:** `12–16px` for dense data; `24px` only for primary empty states.

### Inputs / Fields

- **Style:** midnight inset field, circuit border, `4px` radius.
- **Focus:** cyan border and outline with no layout shift.
- **Error / Disabled:** semantic text plus an explicit message; never rely on color alone.

### Navigation

Navigation is compact, persistent, and label-led. Active state uses cyan text and a structural marker. Links remain recognizable; keyboard focus is always visible.

### Pipeline and State Snapshot

The pipeline is the signature component: numbered stages with explicit complete, current, and waiting substates. The state snapshot presents current job facts with honest timestamps; it must not imply event history the API does not provide. If real event history is exposed later, render it as a readable chronological transcript with level, timestamp, and message columns—not a decorative terminal window.

## Do's and Don'ts

### Do:

- **Do** show current state, progress, errors, and recovery actions without requiring exploratory clicks.
- **Do** use direct verbs, concise labels, and stable placement for repeated controls.
- **Do** make dense information scannable through alignment and consistent data columns.

### Don't:

- **Don't** imitate green-phosphor terminals, scanlines, CRT glow, or fake command prompts.
- **Don't** turn every section into a floating card or every status into a colorful badge.
- **Don't** add marketing copy, decorative book imagery, or motion that delays an operation.
