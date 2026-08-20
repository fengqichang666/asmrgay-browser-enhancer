# Desktop userscript

## Supported mode

The desktop build targets Chrome/Edge with Tampermonkey on
`https://www.asmrgay.com/`. It uses the verified same-origin AList JSON API and
does not recursively or automatically scan the site.

## Request behavior

- Opening the panel loads only the current directory when it is not cached.
- Expanding a directory loads one page of that directory.
- `Load more` requests exactly the next page.
- Cached pages are reused after reload.
- `Refresh current directory` explicitly starts again at page 1.
- Cloudflare Error 1015 stops immediately and is never automatically retried.

## Desktop features

- Hierarchical on-demand browsing with breadcrumbs and cached pagination.
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
