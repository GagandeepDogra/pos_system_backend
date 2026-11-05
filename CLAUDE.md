# CLAUDE.md — Dhaba POS

## Stack
TypeScript end to end. Node 20, NestJS 10 (pos-api), ExcelJS (the only data store, no database), bcryptjs,
Jest + ts-jest + supertest. npm workspaces monorepo. (The planning tool sometimes says "Go/Gin/PostgreSQL";
the requirements mandate NestJS + ExcelJS with no database. Follow the repository.)

## Layout
- `packages/shared/src` — `@dhaba/shared`: **every enum used by both apps** (`enums.ts`, `as const` arrays +
  types) and the row/DTO types of the 15 sheets (`entities.ts`). Never define an enum list elsewhere:
  `apps/pos-api/test/shared-enums.spec.ts` fails if pos-api source has `as const` arrays, TS enums, or
  copies a shared enum list.
- `apps/pos-api/src`
  - `storage/schema.ts` — the v1 workbook schema: 15 sheets, column types, nullability, maxLength, enums,
    unique, `ref` (FK), `indexed`. `SCHEMA_VERSION`. ID columns = `id` + every `ref` column (locked in Excel).
  - `storage/workbook-codec.ts` — `buildWorkbook` (rows → protected ExcelJS workbook) and `parseWorkbook`
    (validates everything, throws `WorkbookValidationError` with an `errors[]` list). Restore validation
    should reuse `parseWorkbook`.
  - `storage/workbook-file.ts` — `readWorkbookFile`, `writeWorkbookFile` (temp file + fsync + rename).
  - `storage/workbook-store.ts` — `WorkbookStore`: in-memory rows with id/unique/non-unique indexes
    (`get`, `all`, `findUnique`, `findBy`, `insert`, `replace`, `toData`). Treat returned rows as read-only;
    mutate with `replace({...row, ...})`. Only the write queue should call insert/replace.
  - `storage/folder-lock.ts` — `FolderLock` on `<DATA_DIR>/.pos-api.lock` (O_EXCL + pid liveness).
  - `storage/journal.ts` — `Journal` on `<DATA_DIR>/dhaba-pos.journal`: one line per committed change,
    `<sha256-16> {"seq","at","ops":[{t:'i'|'u', s:sheet, r:row}]}`, appended with writeSync + fsyncSync.
    A damaged last line = torn write (cut off at open); damaged earlier = `JournalCorruptError` (refuse start).
    `compact(seq)` drops entries ≤ seq — only the backup work should call it, with the seq of a verified
    snapshot (recovery replays the journal past a backup's `last_journal_seq`). Save does NOT compact.
  - `storage/write-queue.ts` — `WriteQueue` (`storage.queue`, also a Nest provider): `run(tx => ...)` runs
    changes one at a time. **Changes must be synchronous** (do async work such as bcrypt before `run`).
    `Tx`: `get/all/findUnique/findBy`, `insert`, `replace`, `expectVersion(sheet,id,ifMatch)` (404/409 with
    `details.current`), `nextCounter(key)` (first value 1), `now`. On throw or journal failure every touched
    row is rolled back (journal failure → 503 SAVE_FAILED, health red). `runIdempotent(sheet, uniqueColumn,
    key, tx => row)` → `{replayed, row}`: a known key returns the stored row without enqueuing (→ HTTP 200).
    `onCommit(listener)` for realtime events / coalesced save scheduling (WI-004).
  - `storage/backup-folder.ts` — backups/ snapshots: `snapshot-YYYYMMDD-HHmmss-<reason>[-n].xlsx` (IST;
    reason = shared `SNAPSHOT_REASONS`: auto | day-close | pre-restore), `retentionPlan(snapshots, now)` (pure:
    keep all ≤30 days, then one per IST day — day-close preferred, else newest — up to 365 days, drop older),
    `BackupFolder` (`list`, `copyIn` temp+fsync+rename, `prune`). Non-`snapshot-*` files are never touched.
  - `storage/backup.service.ts` — `BackupService` = `storage.backups` (also a Nest provider): `snapshot(reason, at)`
    saves first if `storage.lastSavedSeq` lags the journal, copies the live file, verifies the copy with
    `readWorkbookFile` (deletes it on failure), prunes, then `journal.compact(seq of the previous verified
    snapshot)` (one snapshot of slack). `dayCloseSnapshot()` — WI-016 day close calls this (always snapshots,
    resets the 15-min timer). Use `snapshot('pre-restore')` before a restore swap (WI-017). `lastSnapshot`,
    `lastSnapshotError` feed /health `backups` (a snapshot error does not turn health red).
  - `storage/snapshot-scheduler.ts` — `SnapshotScheduler`: checks 15 min after the last snapshot/check, snapshots
    only if `changeSeq` (journal lastSeq) moved and within open hours (`SNAPSHOT_OPEN_HOURS`, IST, null = all
    day). Injectable `SchedulerClock`; tests use `test/support/fake-clock.ts` (`advance(ms, () => sched.whenIdle())`).
    Started by `main.ts` via `storage.backups.startScheduler()` after load; `storage.close()` stops it.
  - `storage/migrations.ts` — `MIGRATIONS[n]` upgrades an ExcelJS workbook v n → n+1 (none yet).
  - `storage/storage.service.ts` — `StorageService`: `lockFolder()` then `load()` (or `open()` = both).
    Load: read → migrate a copy (original copied to `backups/pre-migration-v<n>-*.xlsx`) → parse → replay
    journal past `Meta.last_journal_seq` → save if anything replayed/migrated. `state`: loading | ready |
    corrupt. Unreadable workbook (or missing workbook with journal entries) → `corrupt`: writes blocked,
    `recoveryOffer` = newest valid `backups/*.xlsx` + journal entry count; `recoverFromBackup()` accepts it
    (CLI `npm run recover`, `src/recover.ts`). `save()` writes `last_journal_seq` and never overlaps
    itself. `initialData()` seeds the META and SETTINGS rows (no users yet).
  - `common/errors.ts` — `ApiError(status, code, en, hi, details)` and the 409/404/503 errors.
  - `common/startup.guard.ts` — global guard: every route but /health answers 503 STARTING while loading,
    503 WRITES_BLOCKED when corrupt.
  - `billing/money.ts` — paise helpers (`toPaise`, `fromPaise`, `lineTotal`). Money is computed in integer
    paise and stored as 2-dp strings ("120.00"); workbook cells hold numbers.
  - `billing/order-line.ts` — `buildOrderLine(item, variant, input)` copies the snapshots and the price.
  - `auth/pin.ts` — `hashPin` (bcrypt cost 10, PIN of 4+ digits), `verifyPin`.
  - `auth/auth.guard.ts` — global `AuthGuard` (APP_GUARD after StartupGuard): Bearer HS256 JWT (`auth/jwt.ts`, no
    library) → `req.user: SessionUser` (`@CurrentUser()`); 401 UNAUTHORIZED when missing/forged/expired (12 h or
    shift end)/user inactive/`token_version` bumped. `@Public()` skips it (health is always public). `@Roles(...)`
    (method or class); default = any role, but **any `/api/v1/admin/*` route defaults to ADMIN**. A role denial
    → 403 ACCESS_DENIED + an `ACCESS_DENIED` audit row (entity_type = first path segment, entity_id = `:id` param).
  - `auth/permissions.ts` — `PERMISSIONS[operationId]` = roles for every contract route. **Feature controllers use
    `@Roles(...PERMISSIONS.<operationId>)`**. Approval-gated actions (void, close-exception, cancel after start,
    discount above limit) allow CASHIER; the handler then consumes an approval token.
  - `auth/auth.service.ts` — `AuthService` (Nest provider; `auth.now` clock for tests): `login` (bcrypt before the
    queue; lockout 5 wrong → `locked_until` now+5 min, 401 WRONG_PIN `details.remaining_tries`, 423 USER_LOCKED;
    an expired lock restarts the count), `authenticate`, `sessionExpiry` (min(12 h, next IST `Settings.shift_end_time`),
    kitchen device = `device_role:'KITCHEN'` + Kitchen user ignores shift end). User helpers for WI-014:
    `publicUser` (strip pin_hash — **never return a UserRow**; don't use `tx.expectVersion` on users, its 409
    carries the row), `unlockPatch`, `deactivatePatch` (bumps token_version), `pinResetPatch`, `findAdminByPin`
    (Admin PIN clash check).
  - `auth/approvals.ts` — `ApprovalStore` = `authService.approvals`: in-memory 2-min single-use tokens bound to the
    requesting user. In the approved change call `auth.approvals.consume(token, user.id)` **inside `queue.run`**
    (403 APPROVAL_INVALID) and store the result as `approved_by` / audit `approver_id`. `@ApprovalToken()` reads
    `X-Approval-Token`.
  - `auth/auth.controller.ts` — `GET /auth/staff`, `POST /auth/login`, `POST /auth/approvals` (Idempotency-Key kept
    in memory 24 h per user), `PATCH /me/language`.
  - `auth/jwt-secret.ts` — `loadJwtSecret(env, dataDir)`: JWT_SECRET or JWT_SECRET_FILE (default
    `<parent of DATA_DIR>/pos-api-jwt.secret`, generated mode 600); refused inside DATA_DIR. main.ts passes it to
    `AppModule.register(storage, [], [], { jwtSecret })`.
  - `auth/first-admin.ts` + `create-admin.ts` — `npm run create-admin` (ADMIN_NAME, ADMIN_PIN) seeds the first Admin;
    users ids are `USR-NNNNNN` from counter `USER` (`USER_COUNTER`).
  - `audit/audit.ts` — `writeAudit(tx, {...})` inserts an `AUD-NNNNNN` row (counter `AUDIT`) in the same change.
  - `common/time.ts` — `nowIst()` gives timestamps with +05:30.
  - `storage/repository.ts` — `createStamp`, `updateStamp` (row_version +1, audit columns in a patch are
    ignored), `businessDate(at, resetTime='04:00')` (IST), `counterKeys` (ORDER global; TOKEN:/KOT:/BILL:<date>)
    and `idFormats` (ORD-YYYYMMDD-NNNN, T-NNN, B-YYYYMMDD-NNN, KOT-YYYYMMDD-NNNN, `seq(prefix,n)` = PFX-NNNNNN).
    In the queue use `tx.create(sheet, fields, userId)`, `tx.update(sheet, row, patch, userId)`,
    `tx.businessDate()` (reads Settings.token_reset_time) and `tx.emit(event, payload)`.
  - `storage/save-scheduler.ts` — `SaveScheduler` (REQ-107): first commit of a burst arms a 2 s timer, one
    save per burst; failed save → `onError` + retry in 2 s. `storage.startAutoSave({clock?})` (main.ts calls it
    after load; `close()` stops it), `storage.saveScheduler.flush()` for day close/restore.
    `storage.saveAlert` = the 'Saving problem, call owner' alert (dashboard WI-012 and /health show it).
  - `common/validation.ts` — `FormulaStripPipe` (body strings lose leading `= + - @`; plain numbers kept),
    `createValidationPipe()` (whitelist + forbidNonWhitelisted → 400 VALIDATION_FAILED), `@ServerDerived()`
    for fields a client may send but the server derives (price, unit_price, totals): accepted then dropped.
  - `common/headers.ts` — `@IfMatch()` (missing → 428 IF_MATCH_REQUIRED, bad → 400) and `@IdempotencyKey()`
    (missing → 400). Then `tx.expectVersion(sheet, id, version)` → 409 ROW_VERSION_CONFLICT + details.current.
  - `common/error.filter.ts` — `ApiErrorFilter`: every error (Nest 404s included) → `{code, message_en,
    message_hi, details}`.
  - `realtime/realtime.gateway.ts` — Socket.IO (`/socket.io`); broadcasts each committed tx's `tx.emit` events
    with `seq` and `at` added. Event names = shared `REALTIME_EVENTS`. Rolled-back changes emit nothing.
  - `app.setup.ts` — `configureApp(app, {webDir})`: prefix, pipes, filter, IoAdapter, static PWA (WEB_DIR) on
    non-/api, non-/socket.io paths. **Tests must call it too** instead of `setGlobalPrefix`.
  - `health/health.controller.ts` — `GET /api/v1/health` (no auth): status green/red, workbook (last save,
    error, unsaved_changes), alert, journal, queue, backups; 503 while loading.
  - `app.module.ts` — `AppModule.register(storage, extraControllers?, extraProviders?, auth?)` (`auth` = AuthOptions or an
    AuthService instance); provides StorageService, WriteQueue, BackupService, AuthService, RealtimeGateway,
    StartupGuard + AuthGuard (APP_GUARD), AuthController, MeController.
  - `deploy/profile.ts` — `loadDeployProfile(env)` (part of `loadConfig().deploy`): `DEPLOY_PROFILE` lan|cloud.
    LAN binds only to a private/loopback `HOST` (default `pickLanAddress()`; `0.0.0.0`/public refused), TLS optional
    (mkcert), no CORS. Cloud requires TLS files, an `https://` `CORS_ORIGIN`, `OFFSITE_BACKUP_DIR`; login limit 10/min.
    Problems throw `DeployConfigError` (main refuses to start).
  - `deploy/hardening.ts` — `applyProfile(app, profile)` after `configureApp`: CORS (only the app origin echoed),
    `loginRateLimitMiddleware` on `POST /api/v1/auth/login` (429 TOO_MANY_ATTEMPTS, runs before the auth controller
    WI-005 adds), HSTS with TLS; `createHttpsRedirectServer` for `HTTP_REDIRECT_PORT`.
  - `deploy/offsite-copy.ts` — `OffsiteCopyScheduler`: nightly (IST `OFFSITE_BACKUP_TIME`) `backups.snapshot('auto')`
    copied into `OFFSITE_BACKUP_DIR` with the same retention. `deploy/data-folder.ts` — `restrictDataFolder` (mode 700).
  - `deploy/review.ts` + `deploy-check.ts` — `npm run check:deploy` (exit 1 on failure).
  - `main.ts` — lock folder → listen → `storage.load()` → `startAutoSave` + snapshot scheduler. Exits 1
    ("pos-api refused to start") on a held lock or a damaged journal; a corrupt workbook keeps the server up
    in recovery mode.
- `apps/pos-api/test/auth.e2e.spec.ts` — login/lockout/sessions/approvals/language and the **permission matrix**
  over `test/support/contract-routes.ts` (`CONTRACT_ROUTES` + `stubController(implemented)` stubs with the matrix
  roles). When you build a feature controller, register it in that app and add its operationIds to `implemented`
  so the matrix tests the real routes. Test-only controllers without auth must be `@Public()`.
- `apps/pos-api/test` — fixtures (`sampleData()`, `seededData()` = sample + counters, `tempDir()`), e2e
  specs, `support/pos-ops.ts` (stand-in order/KOT/payment changes for durability tests — replace with the
  real services' calls when they exist), `chaos.spec.ts` (spawns `support/chaos-writer.ts` through
  `support/ts-register.js` and kill -9s it), `lunch-rush.spec.ts`, `core.e2e.spec.ts` with
  `support/demo.controller.ts` (test-only routes showing the controller pattern: DTO + `@IdempotencyKey` +
  `runIdempotent` + `tx.create` + `tx.emit`; socket.io-client checks events), `support/save-bench.ts`.

## Commands (from repo root)
- `npm install`
- `npm test` — jest with coverage; thresholds of 80% on `src/storage/` and `src/billing/` (jest.config.js).
- `npm run build` — builds shared, then pos-api (`tsc -p tsconfig.build.json`).
- `npm start` — `node apps/pos-api/dist/main.js`; env: PORT, HOST, DATA_DIR, WORKBOOK_SHEET_PASSWORD,
  JWT_SECRET / JWT_SECRET_FILE, SNAPSHOT_OPEN_HOURS (optional `HH:mm-HH:mm`; an invalid value fails startup), WEB_DIR (optional PWA build).
- `npm run bench:save -w @dhaba/pos-api` — times saves of a synthetic ≥15 MB workbook (TARGET_MB env).
- `npm run check:deploy` — reviews the deployment env (profile rules, data folder mode, off-server folder).
- Deployment files (repo root): `deploy/windows/install-service.ps1` (NSSM + icacls + firewall),
  `deploy/linux/install.sh` + `ecosystem.config.js` (PM2, 512 MB heap for a 1 GB VPS), `docs/deployment.md`
  (profiles, LAN/cloud checklists, pos.local + mkcert spike). Env: DEPLOY_PROFILE, TLS_CERT_FILE, TLS_KEY_FILE,
  HTTP_REDIRECT_PORT, CORS_ORIGIN, OFFSITE_BACKUP_DIR, OFFSITE_BACKUP_TIME. Without HOST the LAN profile binds the
  LAN IP, so local runs use `HOST=127.0.0.1`.
- `npm run create-admin` — with the server stopped, `ADMIN_NAME=.. ADMIN_PIN=.. DATA_DIR=..` adds the first Admin.
- `npm run recover` — with the server stopped, restore a corrupt live workbook from the newest valid backup
  plus journal replay.

## Conventions
- Test names cite a REQ id (`'REQ-099: ...'`).
- In tests and type-checks, `@dhaba/shared` resolves to the shared sources (tsconfig `paths`, jest
  `moduleNameMapper`); the build uses the built `packages/shared/dist`.
- Global route prefix is `api/v1`. Error body shape: `{code, message_en, message_hi, details}`.
- Values: decimals are 2-dp strings, timestamps are ISO with +05:30, dates are `YYYY-MM-DD`, json columns
  are objects in memory (JSON text in the cell). A blank cell in a required text column reads as `''`.
- ExcelJS gotchas: cells share style objects, so assign `cell.style = {...cell.style, x}` and never mutate
  one cell's style in place. Keep validation ranges finite (data rows + 2000) and the protect spinCount low,
  or load and save get slow.
- Every write goes through `storage.queue` (never `store.insert/replace` directly); the journal line is
  fsync'd before the promise resolves. Creating POSTs with an Idempotency-Key use `runIdempotent`.
  Writes outside the queue are only the derived Meta row in `save()` and replay at startup.
- Controllers: class-validator DTOs never declare `id`, timestamps or audit columns (so a client-sent id is a
  400); creates take `@IdempotencyKey()` and use `runIdempotent` (status 200 when `replayed`, else 201);
  updates take `@IfMatch()` + `tx.expectVersion` + `tx.update`; emit realtime events with `tx.emit` inside
  the change. User-facing errors are `ApiError(status, CODE, en, hi, details)`.
- New sheet or column = change `schema.ts` + `entities.ts` + bump `SCHEMA_VERSION` (migration work).
- CI (to be added by a person, not in .github/workflows here): `npm ci && npm run build && npm test`.
