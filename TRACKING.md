# Feature Tracking — `jonas_dev` Branch

> Branch: `jonas_dev` (ahead of `develop` by 18 commits)
> Last updated: 2026-06-19

---

## Table of Contents

1. [Overview](#overview)
2. [Cloud Sync (Supabase)](#1-cloud-sync-supabase)
3. [Automation Dashboard / UI Settings](#2-automation-dashboard--ui-settings)
4. [Startup Sequence](#3-startup-sequence)
5. [JAV Title Refinement](#4-jav-title-refinement)
6. [Scan Performance Improvements](#5-scan-performance-improvements)
7. [Identify Pipeline Changes](#6-identify-pipeline-changes)
8. [Config Rename: Cloud Sync → Automation](#7-config-rename-cloud-sync--automation)
9. [Known Gaps & Unresolved Issues](#8-known-gaps--unresolved-issues)
10. [Commit Log](#9-commit-log)

---

## Overview

This branch adds several interconnected features to the Stash fork:

| Feature | Status | Key Files |
|---------|--------|-----------|
| Cloud Sync (Push/Pull to Supabase) | ✅ Implemented | `task_cloud_sync.go` |
| Automation Dashboard UI | ✅ Implemented | `SettingsAutomationPanel.tsx`, `context.tsx` |
| Startup Sequence (Scan → Identify → Cloud Push) | ✅ Implemented | `task_startup.go`, `init.go` |
| JAV Title Refinement (r18.dev scraper) | ✅ Implemented | `task_identify.go`, `task_jav_refine_cron.go` |
| Scan Performance (worker decoupling, parallel) | ✅ Implemented | `task_scan.go`, `pkg/ffmpeg/options.go` |
| Identify Pipeline (two-stage, organized gate) | ✅ Implemented | `task_identify.go` |
| Config Rename (Cloud Sync Settings → Automation) | ✅ Implemented | `config.go`, `schema.graphql` |
| **Unified requirement alignment** | ❓ Needs verification | — |

---

## 1. Cloud Sync (Supabase)

### What was built

A full push/pull sync to a Supabase Postgres instance via the Supabase REST API.

**Push (`CloudSyncTask.isPush = true`):**
- Scans local database in batches of 100
- Upserts rows to Supabase tables: `stash_scenes`, `stash_performers`, `stash_studios`, `stash_tags`, `stash_app_settings`
- Uses `on_conflict` resolution with `merge-duplicates`
- Exponential backoff retry (5 attempts, quadratic delay 1s/4s/9s/16s/25s)
- 4xx errors are non-retried (schema mismatch guard)
- Tracks `last_push_at` timestamp
- Uploads sync history (`stash_sync_history`) with scan/identify stats

**Pull (`CloudSyncTask.isPush = false`):**
- Fetches rows from Supabase via `updated_at >= last_pull_at`
- Writes fetched data back into local SQLite database
- Updates `last_pull_at` after completion

**Auto-Push trigger:**
- Watches the job queue for completed Scan/Identify/Generate jobs
- Waits 60 seconds after last matching job completes, then auto-pushes
- Gate: `GetCloudSyncAutoPush()` must be true AND Supabase credentials must be configured

### Key files
- `internal/manager/task_cloud_sync.go` (1004 lines)
- `pkg/sqlite/database.go` (minor)

### Relevant config keys
- `cloud_sync.supabase_url`
- `cloud_sync.supabase_key`
- `cloud_sync.supabase_bucket`
- `cloud_sync.auto_push`
- `automation.cloud_pull` (toggle)
- `automation.cloud_push` (toggle)

---

## 2. Automation Dashboard / UI Settings

### What was built

A new **Automation** tab in the Settings page (`/settings?tab=automation`) with:

**Startup Tasks card:**
- `Startup Scan` toggle (`automation.startup_scan`, default: `true`)
- `Startup Identify` toggle (`automation.startup_identify`, default: `true`)

**Cloud Sync card:**
- `Cloud Pull` toggle (`automation.cloud_pull`, default: `true`)
- `Cloud Push` toggle (`automation.cloud_push`, default: `true`)

**Manual Cloud Actions:**
- Pull from Cloud Now button
- Push to Cloud Now button

**Cloud Configuration section:**
- Supabase URL (string)
- Supabase Key (password masked)
- Supabase Bucket (string, advanced)
- Auto-Push Daily (boolean, default: `false`)

### Key files
- `ui/v2.5/src/components/Settings/SettingsAutomationPanel.tsx` (170 lines)
- `ui/v2.5/src/components/Settings/Settings.tsx` (added import/route)
- `ui/v2.5/src/components/Settings/context.tsx` (added `automation` state, `saveAutomation`)
- `ui/v2.5/src/components/Settings/styles.scss` (new styles)
- `ui/v2.5/src/core/StashService.ts` (added `useConfigureAutomation`)

### GraphQL types
- `ConfigAutomationInput` / `ConfigAutomationResult` in `graphql/schema/types/config.graphql`
- Added `automation` field to `ConfigResult`
- Added `metadataCloudPush` / `metadataCloudPull` mutations via `graphql/schema/schema.graphql`

### Resolver
- `internal/api/resolver_mutation_configure.go` — `ConfigureAutomation` mutation (lines 469–520)
- Persists automation settings to both config file AND `app_settings` SQLite table (for cloud distribution)

---

## 3. Startup Sequence

### What was built

A new `StartupJob` that runs after the server initializes:

1. **Scan** (if `automation.startup_scan` is true)
   - Loads saved Scan preferences from config (`GetDefaultScanSettings()`)
   - Falls back to hardcoded defaults (Rescan=true, generate covers/previews/sprites/phashes)
2. **Identify** (if `automation.startup_identify` is true)
   - Loads saved Identify preferences (`GetDefaultIdentifySettings()`)
   - Falls back to all configured stash-boxes as sources
   - Passes `ScanRescan` from the scan options to control organized skip behavior
3. **Cloud Push** (if `automation.cloud_push` is true)
   - Pushes all data to Supabase
   - Uploads sync history with scan/identify stats

**Timing:** Triggers 2 seconds after `postInit` completes (in `TriggerStartupTasks()`).

### Key files
- `internal/manager/task_startup.go` (133 lines)
- `internal/manager/init.go` (calls `TriggerStartupTasks()` at line 256)

---

## 4. JAV Title Refinement

### What was built

A post-identify step that scrapes r18.dev for English titles and appends them:

**Integration point:** Runs after identify in both paths:
- `identifyAllScenes()` — two-stage pipeline: identify workers → refine workers
- `identifyScene()` — single-scene path (sequential identify + refine)

**Logic (`refineJAVTitleAttempt`):**
1. Skip if scene title already contains ` | ` (already refined)
2. Find r18.dev/r18.com URL from scene URLs
3. Extract CID from URL (`id=`, `combined=`, `cid=` params or last path segment)
4. Fetch `https://r18.dev/videos/vod/movies/detail/-/combined={CID}/json`
5. Parse `title_en` from JSON response
6. Update title to: `{EnglishTitle} | {OriginalTitle}`
7. Apply `decensor()` transformation (replaces censored characters)

**Rate limiting:**
- Global `r18Limiter` (1 request per 2 seconds)
- HTTP 429 handling with `Retry-After` header support
- Exponential backoff on other errors (3 retries max)

**Cron retry:**
- `StartJAVRefineCron()` runs every hour + 10s after startup
- Targets scenes with r18 URL but missing ` | ` in title
- Uses `scene.BatchProcess` for efficient querying

**Organized flag:**
- `SetOrganized` is suppressed during identify (`cloneOptionsWithoutOrganized`)
- Only applied after successful JAV title refinement
- Controlled by user's identify settings (`wantsOrganized()`)

### Key files
- `internal/manager/task_identify.go` — `refineJAVTitle`, `refineJAVTitleAttempt`, `decensor` (lines 566–766)
- `internal/manager/task_jav_refine_cron.go` — `StartJAVRefineCron`, `retryUnrefinedJAVJob` (157 lines)

---

## 5. Scan Performance Improvements

### What was built

- **Worker decoupling:** Scanner and generator worker counts are now independent (`b9272d26`)
- **Parallel generation:** Sprite and preview generation run in parallel workers (`78d16301`)
- **Error hardening:** Generator skips "Invalid NAL unit size" errors that previously crashed sprite generation (`9bf4546f`)
- **Concurrent scanning:** Parallel startup tasks, better concurrency for scanning (`70e9c029`)
- **Hidden brake removal:** Removed the serializing bottleneck that made 100 workers behave like 1 (`59216d6b`)

### Key files
- `internal/manager/task_scan.go`
- `pkg/ffmpeg/options.go`
- `pkg/ffmpeg/transcoder/screenshot.go`

---

## 6. Identify Pipeline Changes

### What was built

**Two-stage pipeline (`identifyAllScenes`):**
- **Stage 1:** `numIdentifyWorkers` (up to 10) workers run the fast identify step (scrape + write metadata)
- **Stage 2:** `numRefineWorkers` (2) workers run slow JAV title refinement (throttled by r18 rate limiter)

**Organized scene handling:**
- `skipOrganized = !j.input.ScanRescan` — when Rescan is false, organized scenes are skipped
- `SetOrganized` is stripped from identify options (`cloneOptionsWithoutOrganized`) so the identify step never marks scenes organized
- Organized flag is applied manually only after a successful JAV title refinement

**Filename parsing fix:**
- `545276fd` — fixed identify filename parsing

**Title field update logic:**
- `0d21975b` — updated title field update logic for the two-stage pipeline

### Key files
- `internal/manager/task_identify.go` (766 lines)
- `internal/identify/options.go` — added `ScanRescan` field

---

## 7. Config Rename: Cloud Sync → Automation

### What was built

New config keys under the `automation.*` namespace:

| Key | Type | Default | Former |
|-----|------|---------|--------|
| `automation.cloud_pull` | bool | `true` | `cloud_sync.auto_pull` (implied) |
| `automation.cloud_push` | bool | `true` | `cloud_sync.auto_push` (different semantics — auto-push after changes) |
| `automation.startup_scan` | bool | `true` | new |
| `automation.startup_identify` | bool | `true` | new |

Old `cloud_sync.*` keys remain for Supabase credentials.

---

## 8. Known Gaps & Unresolved Issues

### ❓ Requirement: "What exactly was the requirement?"

The overarching goal was never formally documented. Based on commit messages and code, the apparent requirements were:

1. **Sync local Stash data to Supabase** (scenes, performers, studios, tags)
2. **Pull remote changes from Supabase** back to local
3. **Automate startup tasks**: scan for new files, identify scenes, push to cloud
4. **Add UI toggles** for all automated behaviors
5. **Improve JAV metadata** by fetching English titles from r18.dev
6. **Improve scan/identify performance** through parallelism
7. **Rename "Cloud Sync Settings" to "Automation"** in the UI

### ❓ Suspected Gaps

1. **Cloud Pull implementation may be incomplete** — the pull path (`CloudSyncTask.Execute` with `isPush=false`) exists but the debounced auto-push trigger (`TriggerCloudSync`) only pushes, never pulls. There is no periodic auto-pull mechanism.

2. **ScanRescan / organized interaction may still not match expected behavior** — the `skipOrganized = !j.input.ScanRescan` logic in `identifyAllScenes` uses the user's scan preference's Rescan flag to decide whether to skip organized scenes during Identify. The user may have intended these to be independent settings.

3. **Log file inflation** — `stash_output.log` and `stash_output_final.log` exist in the working tree (40k+ lines), suggesting debug/verbose logging was added. These may need cleanup before production.

4. **Userscript file** — `Manager (Cloud Sync & Dashboard)-4.1.5.user.js` was added and then deleted in later commits, suggesting the userscript approach was abandoned in favor of built-in code. All traces should be removed.

5. **"Progress stuck" fix (8efe7802)** — the most recent commit is a fix for progress being stuck, suggesting the previous iteration had a UI/UX regression.

### 🔍 To verify with the user

- [ ] What specific behavior is still not matching your requirement?
- [ ] Is the gap in: startup sequence order, organized scene handling, cloud pull frequency, JAV title format, or something else?
- [ ] Do you have a written requirement or spec that this should be compared against?

---

## 9. Commit Log

```
8efe7802  fixed progress stuck
13aad10d  tt
da1ded91  feat: respect cloud pull toggle and startup identify (disregard ScanRescan == false)
0d21975b  feat: respect automation toggles for startup scan, identify, and cloud push tasks, and update title field update logic.
9abd256d  refactor: rename Cloud Sync settings to Automation + add startup scan/identify controls + fix filename parsing during Identify
545276fd  fixed identify filename parsing
4589ae52  feat: implement exponential backoff retry logic for cloud sync upserts with status-specific handling
b9272d26  perf: decouple scanner and generator worker counts to optimize task processing throughput
59216d6b  removed the "Secret Brake" that was making your 100 workers feel like they were going one-by-one
78d16301  better parallel for generation: sprite and preview
9bf4546f  hardened Stash generator: skip over the "Invalid NAL unit size" errors
c4141449  Scan preference will be sync too, Identify will inherit this settings too
09174de7  stash sync startup history stats will be uploaded to Supabase too
0b4d8592  prevent scanning MacOS metadata files
70e9c029  parallel startup tasks + better concurrency for Scanning
395cf5ad  make sure when Startup, also do Scan+Identify+CloudPush
8b36c49e  dont skip alr Organized scenes
c799e01b  fix cloud sync to Supabase
77c8abca  t
```

---

## Files Changed (vs `develop`)

| File | Δ |
|------|---|
| `internal/manager/task_cloud_sync.go` | +1004 lines (new) |
| `internal/manager/task_identify.go` | +506 lines (heavily modified) |
| `internal/manager/task_startup.go` | +133 lines (new) |
| `internal/manager/task_jav_refine_cron.go` | +157 lines (new) |
| `internal/manager/config/config.go` | +109 lines |
| `internal/manager/config/tasks.go` | +3 lines (minor) |
| `internal/manager/init.go` | +23 lines |
| `internal/manager/manager_tasks.go` | +20 lines |
| `internal/manager/task_scan.go` | +37 lines |
| `internal/manager/task_plugin.go` | +2 lines |
| `internal/api/resolver_mutation_configure.go` | +79 lines |
| `internal/api/resolver_query_configuration.go` | +30 lines |
| `internal/api/server.go` | +16 lines |
| `internal/identify/identify.go` | +17 lines |
| `internal/identify/options.go` | +3 lines |
| `graphql/schema/schema.graphql` | +6 lines |
| `graphql/schema/types/config.graphql` | +30 lines |
| `pkg/ffmpeg/options.go` | +6 lines |
| `pkg/ffmpeg/transcoder/screenshot.go` | +4 lines |
| `pkg/job/manager.go` | +9 lines |
| `pkg/job/task.go` | +8 lines |
| `pkg/match/path.go` | +2 lines |
| `pkg/models/app_settings.go` | +9 lines |
| `pkg/models/repository.go` | +1 line |
| `pkg/scraper/autotag.go` | +42 lines |
| `pkg/sqlite/app_settings.go` | +51 lines |
| `pkg/sqlite/database.go` | +6 lines |
| `pkg/sqlite/transaction.go` | +1 line |
| `pkg/stashbox/scene.go` | +6 lines |
| `ui/v2.5/.../*` | +multiple (Settings panel, GraphQL, locale) |
| `stash_output.log` / `stash_output_final.log` | Log files (non-code) |
