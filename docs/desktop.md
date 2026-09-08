# Desktop userscript

## Supported mode

The desktop build targets Chrome/Edge with Tampermonkey on
`https://www.asmrgay.com/`. It uses the verified same-origin AList JSON API.
Normal browsing remains on demand; recursive scanning only starts after the user
selects a root directory and presses the scan button.

## Request behavior

- Opening the panel loads only the current directory when it is not cached.
- Expanding a directory loads one page of that directory.
- `Load more` requests exactly the next page.
- Cached pages are reused after reload.
- `Refresh current directory` explicitly starts again at page 1.
- `Automatic recursive scan` can walk a selected site directory breadth-first,
  using a user-configured interval between directory requests (default 30
  seconds) and saving a checkpoint after each completed directory.
- Each directory scan follows AList pagination from page 1 until `total` is
  reached or the 200-page safety cap is reached; page requests use the same
  configured interval.
- The automatic scan supports pause, continue, stop, and resume after reload.
- If a directory still fails after the configured retries, the scan pauses and
  keeps that directory at the front of the checkpoint queue; `Continue` retries
  it. Rate-limit responses (429/Cloudflare 1015) still stop immediately.
- Cloudflare Error 1015 stops immediately and is never automatically retried.

## Desktop features

- Hierarchical on-demand browsing with breadcrumbs and cached pagination.
- User-triggered recursive directory indexing with conservative throttling.
- Search across loaded data and filters for directory, file, favorite, seen, and unseen.
- Favorites and seen state stored in IndexedDB.
- Manual directory/file reclassification for ambiguous entries.
- Refresh comparison marks removed entries missing without deleting history.
- Per-directory failure state and click-to-retry behavior.
- Windowed result rendering for large indexes.
- Complete index JSON, favorites JSON, favorites CSV, and failure-log export.
- Merge and replace import modes with origin, version, size, and shape validation.
- Safe new-tab links with `noopener noreferrer`.

## Backup and privacy

Exports may contain browsing history, directory names, favorites, and seen state.
Export files are the user's backup and may be copied into synced download folders.
The userscript has no telemetry and does not proxy, download, or cache media files.

## Deferred compatibility work

GBK/GB18030 fixtures, full HTTP error fixtures, and the hidden iframe/live-DOM
fallback are deferred to M5 release hardening. The current supported mode is the
verified UTF-8 AList API on `www.asmrgay.com`.
