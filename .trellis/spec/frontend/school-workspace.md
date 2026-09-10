# School Workspace

`/schools` renders `components/product/XuequReplica.tsx` inside `ProductShell`.

## Views and Controls

- The two views are school index and district overview. Tabs use accessible names
  and SVG icons from `lucide-react`; do not use emoji or text glyphs as icons.
- School index groups records by district and school stage. Every group starts
  collapsed. Each group toggles independently through a button with
  `aria-expanded`. School names link to `/schools/:id`; the separate map icon
  retains district and school query parameters. Do not restore a detail button.
- The primary search is a labeled search input. Region and area filters are
  secondary controls. Preserve search state when switching views.
- District overview defaults to aggregated metrics, admission information,
  relation categories and area counts, without school lists. Each street/area
  name is an independently toggleable button with `aria-expanded` and
  `aria-controls`. All start collapsed. Explicit expansion reveals that area's
  schools, evaluations, feeder middle schools and source relations; school
  names link to their detail pages. Keep relation-only areas accessible.
  Group details by the same `street || area || fallback` key as their counts,
  within the district. Its scope is the selected district, not the index's
  active school query or area filter.
- Do not restore the data-explanation strip or expose database table names in
  product copy.

## Metric Semantics

Use the nine product districts. Keep the existing schools and district-relations
API contracts. District school statistics come from the school dataset/summary.
The district-relations response includes unbound source records, while the
school-summary relation count counts canonical-school bindings. These are not
interchangeable denominators.

Relation categories are mutually exclusive, in this order:

1. `officialAreaLevel === "administrative_or_enrollment_area"`: official area.
2. `residentialPoi === true`: residential community relation.
3. Otherwise: other source relation.

Official source classification does not imply verification. Show verification
using the actual `verified` field. Area counts describe source records and must
not be presented as authoritative citywide coverage.

## Verification

`tests/xuequ-replica-route.test.ts` checks the route and vocabulary.
`tests/schools-workspace-browser.test.ts` checks both viewport sizes, collapsed
groups, SVG map links, search state, no school lists in the default overview,
and independent, keyboard-accessible street expansion including source-only areas.
Run these against the restarted application after production build. Check real
data screenshots for both views at desktop and mobile sizes.

Do not run HTTP tests against an old standalone server while rebuilding its
`.next` directory: builds replace the manifests used by that live process.
Restart after static assets and runtime environment are ready, then run tests.
