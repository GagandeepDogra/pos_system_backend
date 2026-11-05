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
  - `storage/storage.service.ts` — `StorageService.open()` (lock → create the file if missing → load),
    `save()`, `close()`. `initialData()` seeds the META and SETTINGS rows (no users yet).
  - `billing/money.ts` — paise helpers (`toPaise`, `fromPaise`, `lineTotal`). Money is computed in integer
    paise and stored as 2-dp strings ("120.00"); workbook cells hold numbers.
  - `billing/order-line.ts` — `buildOrderLine(item, variant, input)` copies the snapshots and the price.
  - `auth/pin.ts` — `hashPin` (bcrypt cost 10, PIN of 4+ digits), `verifyPin`.
  - `common/time.ts` — `nowIst()` gives timestamps with +05:30.
  - `health/health.controller.ts` — minimal `GET /api/v1/health`; extend it with save/journal status.
  - `app.module.ts` — `AppModule.register(storage)`: storage is opened in `main.ts` before Nest starts.
  - `main.ts` — exits 1 with "pos-api refused to start" on a folder lock or an invalid workbook.
- `apps/pos-api/test` — fixtures (`sampleData()`, `tempDir()`) and e2e/guard specs.

## Commands (from repo root)
- `npm install`
- `npm test` — jest with coverage; thresholds of 80% on `src/storage/` and `src/billing/` (jest.config.js).
- `npm run build` — builds shared, then pos-api (`tsc -p tsconfig.build.json`).
- `npm start` — `node apps/pos-api/dist/main.js`; env: PORT, HOST, DATA_DIR, WORKBOOK_SHEET_PASSWORD.

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
- New sheet or column = change `schema.ts` + `entities.ts` + bump `SCHEMA_VERSION` (migration work).
- CI (to be added by a person, not in .github/workflows here): `npm ci && npm run build && npm test`.
