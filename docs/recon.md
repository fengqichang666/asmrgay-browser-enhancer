# M0 Reconnaissance — asmrgay.com

Date: 2026-08-20 (Asia/Shanghai)

## Scope and method

Read-only probes were made against the public site with PowerShell
`Invoke-WebRequest`. No credentials, cookies, or browser session were supplied.
Representative paths were the root (`/`), a nested directory (`/asmr` and
`/asmr/中文音声/35夏天`), and a content/file path (`/asmr/常见问题.md` plus a
directory containing media files).

## Findings

### Rendering and links

- `GET /` and `GET /asmr` both return HTTP 200 `text/html`, UTF-8, about 6.9 KB.
- The raw HTML is an AList V3 application shell (`<meta name="generator" content="AList V3">`)
  with Vite JavaScript bundles. It contains no usable directory entry links; the
  only extracted `href` values are CDN/logo links.
- Directory entries are loaded after JavaScript rendering through same-origin
  JSON endpoints. A direct probe of `POST /api/fs/list` with
  `{path:"/", page:1, per_page:0}` returned 7 directory entries and a Markdown
  readme. `/api/fs/list` for `/asmr` returned 19 entries (14 directories and 5
  Markdown files).
- A nested directory `/asmr/中文音声/35夏天` returned 21 entries, all media files
  (`type: 3`, `.mp3`) in the first page. This is a content/detail-like view rather
  than an HTML detail document.

### Pagination / loading behavior

- `/api/fs/list` accepts `page` and `per_page`. `/asmr/中文音声` reported
  `total: 311`; requesting `per_page: 5` returned 5 entries, proving pagination.
- The tested response included `next_marker: null`; page-number progression must
  be verified in the scanner adapter and bounded per directory. Do not infer that
  arbitrary numeric query parameters are child links.
- No infinite-scroll or load-more control is present in the raw HTML. The visible
  list is application-rendered and may be paginated by API calls.

### Encoding

- HTTP HTML responses declared `Content-Type: text/html` and PowerShell detected
  UTF-8. The root JSON endpoint declared `application/json; charset=utf-8` and
  preserved Chinese names correctly.
- The implementation should still decode fetched bytes with `arrayBuffer()` plus
  `TextDecoder`; UTF-8 is observed, not assumed for all future paths.

### Requests, redirects, and access

- `POST /api/fs/list` and `GET /` returned HTTP 200 in the probes.
- `robots.txt` returned HTTP 200 with `User-agent: *` and `Allow: /`.
- `sitemap.xml` returned the same HTML application shell, not an XML sitemap.
- Bare-host `https://asmrgay.com/` could not be established from this probe
  environment (TLS failure), so `www` and bare host remain distinct origins.
- A file metadata probe for `/asmr/常见问题.md` returned HTTP 200 at the transport
  layer but JSON `code: 500`; this is recorded as an application-level failure and
  must not be treated as a successful file fetch.

### Rate-limit probe

- Eight sequential `/api/fs/list` requests with a 350 ms pause all returned 200,
  with no `Retry-After`, 403, or 429. Individual responses took approximately
  0.8–2.4 seconds.
- Conservative initial budget for M1/M2 fixtures and the live adapter: maximum
  concurrency 1–2 until user validation; minimum inter-request delay 500 ms with
  random jitter 0–500 ms. Raise only after observing stable behavior in the user's
  normal browser.

## M0 decision gate

Selected scanner mode: **same-origin API/fetch adapter with live-DOM fallback**.

The site is JavaScript-rendered, so a raw-HTML recursive parser is insufficient.
The first implementation should target the observed AList `/api/fs/list` contract
behind a site adapter, while retaining a hidden same-origin iframe/live DOM path for
pages or deployments where API access differs. `MutationObserver` may be used only
on the live page/iframe DOM, never on a `DOMParser` document.

Credential policy: default requests use `credentials: 'omit'`. If the user confirms
that public content requires the active session, add an explicit opt-in setting with
a privacy warning.

## Open validation items before broad crawling

1. In the normal desktop browser, confirm that page 2 of a 311-entry directory is
   available and identify the exact API pagination semantics.
2. Confirm whether `/api/fs/list` is stable for concurrent requests and whether the
   browser receives any WAF challenge not seen by this read-only probe.
3. Confirm a representative file's real download/raw URL through the rendered UI;
   media URLs must be indexed but never fetched or proxied by the enhancer.
