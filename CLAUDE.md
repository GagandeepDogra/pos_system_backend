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
  - `common/time.ts` — `nowIst()` gives timestamps with +05:30.
  - `health/health.controller.ts` — minimal `GET /api/v1/health`; extend it with save/journal status.
  - `app.module.ts` — `AppModule.register(storage, extraControllers?)`; provides StorageService, WriteQueue,
    StartupGuard (APP_GUARD).
  - `main.ts` — lock folder → listen → `storage.load()`. Exits 1 ("pos-api refused to start") on a held
    lock or a damaged journal; a corrupt workbook keeps the server up in recovery mode.
- `apps/pos-api/test` — fixtures (`sampleData()`, `seededData()` = sample + counters, `tempDir()`), e2e
  specs, `support/pos-ops.ts` (stand-in order/KOT/payment changes for durability tests — replace with the
  real services' calls when they exist), `chaos.spec.ts` (spawns `support/chaos-writer.ts` through
  `support/ts-register.js` and kill -9s it), `lunch-rush.spec.ts`.

## Commands (from repo root)
- `npm install`
- `npm test` — jest with coverage; thresholds of 80% on `src/storage/` and `src/billing/` (jest.config.js).
- `npm run build` — builds shared, then pos-api (`tsc -p tsconfig.build.json`).
- `npm start` — `node apps/pos-api/dist/main.js`; env: PORT, HOST, DATA_DIR, WORKBOOK_SHEET_PASSWORD.
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
- New sheet or column = change `schema.ts` + `entities.ts` + bump `SCHEMA_VERSION` (migration work).
- CI (to be added by a person, not in .github/workflows here): `npm ci && npm run build && npm test`.
