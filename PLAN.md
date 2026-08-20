# ASMRGay Browser Enhancer

## Goal

Build an independent browsing layer for `https://www.asmrgay.com/` that turns nested
directories into a searchable, filterable index. The original site is not modified,
media is not proxied or cached, and no account or telemetry is added.

The plan is gated: implementation of the recursive scanner starts only after M0 proves
that the site's pages, encoding, rendering mode, and request limits support it.

## Milestones

### M0 - Reconnaissance gate

Use the user's normal desktop browser to inspect 2-3 representative pages: the root,
one nested directory, and one content/detail page.

Record:

- Whether links are present in raw response HTML or only after JavaScript rendering.
- Whether the page uses pagination, infinite scroll, or load-more controls.
- Response encoding from headers and any HTML meta declaration; decode with
  `arrayBuffer()` plus `TextDecoder`, never assume `response.text()` is correct.
- Whether direct same-origin requests return HTML, redirects, 403/429, or another
  response type.
- A conservative request budget: minimum delay, jitter, concurrency, and whether a
  short probe triggers rate limiting or WAF behavior.
- Opportunity checks for `robots.txt` and `sitemap.xml`; neither is required, but a
  valid sitemap may reduce crawling.

Decision gate:

- If raw HTML contains usable links, the scanner may use a fetch/parser path.
- If content is JavaScript-rendered, use a hidden same-origin iframe or a
  “browse-as-you-go” mode that indexes the real page DOM. `MutationObserver` applies
  only to the live page/iframe DOM, never to a `DOMParser` document.
- If requests are blocked or unstable, disable recursive crawling and deliver the
  current-page/live-DOM indexer first.

M0 produces a short `docs/recon.md` with evidence and the selected scanner mode before
M1 begins.

### M1 - Pure core and baseline tests

Create shared, DOM-independent TypeScript modules for URL normalization, classification,
graph merging, query/filtering, serialization, and import validation.

The initial mainline uses the verified UTF-8 AList JSON API. Add unit and mock-based
tests needed by each mainline feature as it is implemented.

The full compatibility fixture server is deferred to M5 (release hardening) and will
cover:

- Static HTML fixtures.
- A JavaScript-rendered directory fixture.
- GBK/GB18030 and UTF-8 fixtures.
- Pagination and infinite-scroll fixtures.
- 404, 403, 429 with `Retry-After`, 5xx, timeout, redirect, and non-HTML responses.
- A throttling fixture for concurrency and backoff tests.

Use Vitest for unit tests and integration tests against the fixture server.

### M2 - Desktop userscript and on-demand browser index

Build the Tampermonkey userscript for Chrome/Edge desktop:

- Explicit metadata: `@match`, `@grant`, and `@run-at`.
- A side button opens a Shadow DOM panel so site CSS cannot corrupt the UI.
- Dense desktop list, responsive layout, directory tree, breadcrumbs, search, filters,
  favorites, seen state, progress, pause, stop, continue, and failure retry.
- New-tab opening must include `noopener,noreferrer` behavior.
- Scan only same-origin HTTP(S) links and filter login, forms, scripts, external links,
  and obvious state-changing actions.
- Do not start a recursive scan automatically and do not offer an all-site scan in the
  mainline UI. Index directories on demand: expanding a directory fetches that single
  directory, stores the result, and reuses the cached result until the user explicitly
  refreshes that directory.
- Keep requests single-directory, single-flight, and conservative. A visible refresh
  action is the only normal way to re-request an already loaded directory.
- Apply the M0-derived minimum delay and random jitter between requests.
- Retry only transient failures (network errors, 429, and 5xx) in the low-level adapter,
  but the on-demand UI must stop on Cloudflare rate-limit pages and must not launch a
  retry loop. Do not retry 404 or
  permanent 4xx. Honor `Retry-After`, use exponential backoff with a cap, and open a
  circuit breaker after a configurable consecutive-failure threshold (default 5).
- Abort parsing early for non-HTML responses using response `Content-Type` and an
  extension denylist for audio, video, images, archives, and other binary files.
- Handle pagination explicitly: recognize `rel=next`, common page controls, and
  `?page=N`; cap pages per directory and avoid treating arbitrary numeric query values
  as unbounded children.
- Classify entries with a documented heuristic based on URL shape, page controls,
  child-link density, and presence of audio/media elements. Add a manual reclassify
  action for ambiguous entries.
- Keep the scanner behind an adapter boundary. The hidden same-origin iframe/live-DOM
  fallback and `MutationObserver` path are deferred to M5 because M0 verified that the
  public AList JSON API is currently available and stable enough for the mainline.

### M3 - Storage, export, and import

Use IndexedDB for the graph, crawl state, favorites, seen state, and failure log.
Use localStorage only for UI settings and small preferences. Request
`navigator.storage.persist()` where supported and show an “export is your backup” notice.

Exports:

- `index.json` for the browsing graph and crawl metadata.
- `favorites.json` for complete favorite restoration.
- Favorites CSV for human-readable inspection.
- Include `schemaVersion`, `exportedAt`, source origin, and scanner mode in every JSON.
- Export crawl logs and failure lists for troubleshooting.

Imports:

- Validate file size, JSON shape, field types, origin, and supported `schemaVersion`.
- Reject unknown schema versions with an actionable error.
- Render imported titles with `textContent`/safe DOM APIs only; never inject imported
  strings with `innerHTML`.
- Default to merge: graph nodes by normalized URL, edges by parent/child/position,
  favorites by URL. Offer explicit replace mode.

Credential policy must be explicit in the implementation. Default crawler requests use
`credentials: 'omit'` to avoid exporting or replaying privileged sessions. If M0 proves
that public content requires the active session, make “use current session” a visible,
opt-in setting with a privacy warning; it must never be implicit.

### M4 - Android static page/PWA

Provide a standalone responsive page that consumes `index.json` and favorites exports.

- Static hosting or a local HTTP server is required for installable PWA behavior,
  service workers, and reliable IndexedDB persistence.
- `file://` is supported only as a read-only import/view fallback; it is not advertised
  as an installable or fully persistent PWA mode.
- Include `manifest.json` and a service worker for static-hosted offline use.
- Support Android Chrome and Edge file-picker import, merge/replace behavior, search,
  filters, favorites, and safe new-tab links with `noopener,noreferrer`.
- Document transfer options: USB, a private cloud drive, or the user's own static host.

### M5 - Compatibility and release hardening

Complete this milestone after the desktop mainline and Android/PWA are functionally
usable, but before describing the project as broadly compatible or release-ready.

- Add the local fixture HTTP server and integration coverage for GBK/GB18030 and UTF-8
  byte decoding, 404, 403, 429 with `Retry-After`, 5xx, timeout, redirects, non-HTML
  responses, pagination, throttling, and circuit breaking.
- Implement the hidden same-origin iframe/live-DOM fallback for cases where the AList
  API is unavailable or changes. Use `MutationObserver` only on live page/iframe DOM.
- Re-run Chrome/Edge desktop smoke tests and document the supported scanner modes.
- Until this milestone is complete, document current compatibility as the verified
  `https://www.asmrgay.com/` AList JSON API with UTF-8 responses only.

## Graph Data Model

Do not model the index as a flat list. Use a graph:

- `Node`: normalized unique URL, title, type (`directory` or `content`), discoveredAt,
  lastSeenAt, status (`active` or `missing`), metadata, and local state.
- `Edge`: `parentId`, `childId`, source page URL, display label, and `position` from the
  source page. This preserves source order even when a node appears in multiple paths.
- `CrawlState`: visited URL set, persisted frontier entries with URL and depth, active
  run id, limits, counters, pause/stop state, and failure records.

On a later rescan, update `lastSeenAt` and mark previously known but unobserved nodes
`missing`; do not delete them automatically.

## URL Normalization Rules

Centralize and test these rules:

- Resolve relative URLs against the source page.
- Lowercase the host; preserve path case.
- Remove fragments.
- Remove known tracking parameters such as `utm_*`; retain functional parameters such
  as `page`.
- Sort retained query parameters by key/value deterministically.
- Normalize percent-encoding without changing reserved separators.
- Use a conservative trailing-slash policy: root paths normalize to `/`; non-root
  paths preserve the source URL's trailing slash and are not silently folded together.
- Convert HTTP to HTTPS only when the origin has been verified to support it.
- Treat `www` and bare host as distinct until M0 proves they are equivalent.

## Project Structure

```text
asmrgay-browser-enhancer/
  PLAN.md
  package.json
  tsconfig.json
  src/
    core/          # pure normalization, graph, classification, query, schema
    scanner/       # fetch/iframe/live-DOM adapters and crawl scheduler
    userscript/    # Tampermonkey entrypoint and Shadow DOM panel
    index-page/    # Android/static page UI
    storage/       # IndexedDB repositories and export/import
  fixtures/
  tests/
  docs/
    recon.md
  public/
    manifest.json
    service-worker.js
```

The userscript and Android page must consume the same `core`, schema, and storage
serialization modules. DOM adapters remain separate from pure logic so depth, graph,
normalization, and import tests have stable entry points.

## Measurable Acceptance Criteria

- M0 evidence exists before recursive scanner implementation starts.
- Before release, unit and fixture integration tests cover depths 1, 5, and 10,
  pagination, dynamic DOM, GBK/UTF-8, all retry classes, binary responses, and circuit
  breaking. These release-hardening tests do not block earlier functional milestones.
- For a 10,000-node imported index, search response is under 100 ms in a production
  build and the first visible result set renders within 200 ms on a typical desktop.
- The result list uses virtualization or windowing; it must not mount all 10,000 rows.
- Pause/stop/continue survives page reload without losing the persisted frontier.
- Duplicate URLs retain all parent edges and source positions.
- Active/missing status and `lastSeenAt` are updated on rescan.
- Unsafe or invalid imports are rejected without DOM injection or partial mutation.
- A failed scan can export its failure log for diagnosis.
- Desktop Chrome/Edge and Android Chrome/Edge smoke tests pass for the selected M0 mode.

## Privacy and Operational Constraints

- Personal use only; review the site's terms and `robots.txt` before scanning.
- Use low request rates, bounded concurrency, jitter, backoff, and circuit breaking.
- No telemetry, analytics, or data upload.
- Warn that exported JSON/CSV contains browsing history and preferences and may be
  copied into synced download folders.
- No privileged browser session is sent unless the user explicitly enables it.
