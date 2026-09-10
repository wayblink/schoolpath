# Schools workspace refinement

Implemented the follow-up UI request: SVG icons, removal of the source-explanation
strip, a prominent searchable school index, and a merged district overview.

- `components/product/XuequReplica.tsx`: two accessible tabs; clearable search;
  independent collapsed district/stage groups; canonical school/map links;
  district-only overview with school metrics, admission system, mutually exclusive
  relation categories, verification/year information and area aggregates.
- `app/school-workspace.css`, imported by `app/globals.css`: scoped layout,
  controls, typography and responsive styles.
- School search now includes district names. Search/area state is excluded from
  overview statistics; switching views preserves search input.
- No backend, database or source ingestion changes.

## Validation

The updated HTTP and browser tests failed against the previous three-view page
before the new implementation was served. After implementation:

- Focused ESLint and TypeScript checks passed.
- Production build finished successfully with exit code 0.
- Confirmed the old listener's cwd, stopped that House process, completed the
  build, copied static/public assets, then restarted standalone with `.env.local`.
- `pnpm test`: 261 passed, zero failed.
- Live Chromium checks at 1440px and 390px: 19 groups initially collapsed;
  independent expansion/collapse; two tabs; query preserved on return; overview
  has nine district dashboards, zero school tables/cards/detail links; district
  filtering works; no page errors or document horizontal overflow.
- Visually reviewed both views at both widths:
  `/tmp/house-schools-index-1440.png`, `/tmp/house-schools-index-390.png`,
  `/tmp/house-schools-overview-1440.png`, `/tmp/house-schools-overview-390.png`.

The running application is available at `http://localhost:3000/schools`.
Changes remain uncommitted, consistent with the existing workspace state.

## Follow-up: expandable street details

The user's next request restores details through explicit street/area expansion.
All street rows start collapsed and toggle independently. Expanded rows show
school links, source tiers/tags, evaluations, feeder middle schools and all
relations assigned to the same district and street/area key. Relation-only areas
remain accessible; source classification and verification remain separate.

- Added a browser regression before implementation; the previous running page
  failed because it had no street toggle button.
- Focused ESLint, TypeScript, reviewer checks and production build passed.
- Restarted the confirmed House standalone process after the build completed.
- Six focused route/browser tests passed, including desktop/mobile expansion,
  independent collapse, Enter/Space, cross-district isolation and source-only areas.
- Live Chromium smoke at 1440px and 390px expanded Huangpu's 半淞园路 area and
  verified 上外-黄浦外国语小学 and 大同初级中学, then collapsed it. No console/page
  errors or document horizontal overflow. Browser plugin not available; used the
  existing Playwright dependency. Screenshots: `/tmp/house-street-expanded-1440.png`
  and `/tmp/house-street-expanded-390.png`.
- No API or database changes; the full repository suite was not rerun for this
  narrow follow-up. The six relevant tests cover the changed behavior.

## Follow-up: homepage content width

Homepage `main` now reuses the ordinary product page's 1180px centered container.
Its hero and entry section supply matching responsive padding; homepage-only
heading sizes are 44px desktop and 32px mobile to fit the narrower layout.
Changed `app/page.tsx`, `app/globals.css`, and documented the shared layout in
`.trellis/spec/frontend/component-guidelines.md`.

Focused lint/typecheck and the final production build passed. Restarted the
confirmed House standalone process, then measured against `/sources` in live
Chromium using `/tmp/house-home-width.mjs --verify`: homepage main width 1180px
at viewport 1440px (x=130) and 1920px (x=370), and width 390px at viewport 390px.
Hero/title and entry content edges align with the reference page; mobile has
16px inner padding. No horizontal overflow or console/page errors, and the
primary school action navigates successfully. Reviewed desktop/mobile images
`/tmp/house-home-after-1440.png` and `/tmp/house-home-after-390.png`.

A review concern about duplicate mobile padding was disproven by CSS specificity
and live geometry: `.product-page.home-page` overrides the less-specific later
`.product-page` rule. No additional override was needed. No API/data changes,
new dependencies or commits; the full repository suite was not rerun for styling.

## Follow-up: homepage lower information architecture

Expanded `/` after the user reported excessive empty space below the entry cards.
The homepage now includes three product sections in the same narrow container:

- a linked three-step workflow: find a school, confirm the pathway, and check the
  residential location;
- a real nine-district coverage section using the existing `getOverview()` values
  for schools, communities, assignments, policies, pending matches and conflicts;
- a sources and review section linking to `/sources` and `/ops`, explaining that
  source records and review states remain separately inspectable.

Changed `/Users/jyxc-dz-0101035/yard/house/app/page.tsx`,
`/Users/jyxc-dz-0101035/yard/house/app/globals.css`, and documented the shared
homepage container convention in
`/Users/jyxc-dz-0101035/yard/house/.trellis/spec/frontend/component-guidelines.md`.
No API, database, dependency, commit, PR or deployment changes.

`pnpm exec eslint app/page.tsx` and `pnpm exec tsc --noEmit --incremental false`
passed. `pnpm build` completed with exit 0 after stopping the confirmed House
standalone listener and restarting it at `http://localhost:3000` from
`/Users/jyxc-dz-0101035/yard/house/.next/standalone`. Six existing focused route
and school browser tests passed. Live Playwright Chromium at 1440px and 390px
confirmed five homepage sections, the workflow and coverage headings, no page or
console errors, no horizontal overflow, and a valid `/schools` CTA navigation.
Screenshots: `/tmp/house-home-complete-1440.png` and
`/tmp/house-home-complete-390.png`. Browser plugin was unavailable, so the
existing Playwright dependency was used. Full repository tests and other browsers
remain unrun for this homepage-only extension.

## Follow-up: Zillow-style wide layout

The homepage and ordinary product pages now share a `1320px` centered content
track, matching the existing school workspace width. At 1440px the track starts
at x=60; at 1920px it starts at x=300. The school page keeps its full-width
outer workspace while `.sw-content` uses the same 1320px inner track. Mobile
layouts remain viewport width with 16px inner padding where applicable.

Live Playwright Chromium checks covered `/`, `/schools`, `/pathways`, and
`/sources` at 1440px, 1920px, and 390px. All measured pages had no horizontal
overflow and no console or page errors. Reviewed desktop and mobile screenshots
for the homepage and school workspace. The standalone House service was
restarted after the successful production build and remains available at
`http://127.0.0.1:3000/`.

Changed `app/globals.css` and this verification record. No API, database,
dependency, or data changes; no commit, PR, or remote deployment.

The first 1320px pass was corrected after visual review: it still behaved as a
fixed centered container on very wide displays. The current implementation uses
a fluid desktop canvas with responsive side gutters, and the school workspace
uses the same full-width inner canvas. Live measurements now report 1440px and
1920px page widths for all four checked routes, with no overflow or browser
errors; the 390px mobile checks remain clean.
