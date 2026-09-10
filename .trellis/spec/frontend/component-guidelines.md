# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

Ordinary product pages use `<main className="product-page">` inside
`ProductShell`. The shared `--product-content-max: 1180px` token in
`app/globals.css` sets their centered desktop width, with responsive side padding.
The homepage uses `product-page home-page`; its main has no padding, while its
hero and entry sections supply matching responsive padding so their content
edges align without text touching the hero background's edge.
When changing homepage width, compare its main bounding box with `/sources` at
1440px and 1920px, and check overflow and navigation at 390px. Preserve explicit
map and school-workspace layout rules; those surfaces have separate constraints.

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)
