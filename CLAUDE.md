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
    `<sha256-16> {"seq","at","ops":[{t:'i'|'u'|'d', s:sheet, r:row}]}` ('d' = archive prune, r = {id}), appended with writeSync + fsyncSync.
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
    StartupGuard + AuthGuard (APP_GUARD), AuthController, MeController and **`FEATURE_CONTROLLERS`** — add each new
    feature controller to that list (main.ts and every test app get it) and its operationIds to `implemented` in
    `test/auth.e2e.spec.ts`.
  - `billing/totals.ts` — `computeTotals(order, lines, payments, settings)` → subtotal (ACTIVE lines), discount (clamped),
    tax (GST % on subtotal−discount, 0 when null), round_off (half-up to the rupee), grand_total, paid (SUCCESS), balance.
    Use it whenever lines/payments/discount change (WI-008/009/010 may extend it, keep one function).
  - `tables/table-status.ts` — derived status (shared `TABLE_STATUSES`: AVAILABLE | OCCUPIED (OPEN) | READY_TO_CLOSE
    (BILLED)); `activeOrderForTable(storeOrTx, tableId)` = the one OPEN/BILLED order (use it for TABLE_BUSY / deactivate
    checks); `tableCard` (Kitchen: no `running_total`/`balance_due`). `tables.controller.ts` = `GET /tables?area&status`
    (minutes_open uses `auth.now()`).
  - `orders/dine-in.ts` — queue changes `openSession`, `moveSession`, `mergeSessions` (+ MOVE/MERGE/CREATE audit, events),
    `blankOrder()`, `isOpenOrder`, `TableBusyError` (409 TABLE_BUSY, `details.order`), and `orderView(store, order)` =
    order + `kots[]` (each with `lines`, oldest first) + `payments` — the getOrder body; reuse it for bill/receipt.
    Merge: source lines get `order_id` = survivor (KOTs keep their order_id; orderView finds them via `kot_id`), source
    becomes CANCELLED + `merged_into_order_id` + zero totals, a BILLED survivor reopens to OPEN with a BILL_REOPEN
    exception (reason_code MERGE), a source with SUCCESS payments → 409 SOURCE_HAS_PAYMENTS.
    `orders.controller.ts` — `POST /orders/dine-in`, `GET /orders/:id` (Cashier: 403 ORDER_NOT_VISIBLE for another
    user's closed order, RSK-002), `POST /orders/:id/move`, `POST /orders/:id/merge`. WI-011's takeaway route can go in
    this controller (it is `@Controller('orders')`).
  - `menu/availability.ts` — today's availability (REQ-074/056): `isAvailableToday(item, today, resetTime)` (a FALSE set on
    an earlier business day already counts as TRUE — **WI-008's ITEM_UNAVAILABLE check must use it**, with
    `todayOf(store, at)` / `resetTimeOf(store)`), `setAvailability(tx, id, ifMatch|null, available, userId, source)`
    (audit AVAILABLE/OUT_OF_STOCK, emits `menu.availability_changed`; KITCHEN source adds `alert{message_en,message_hi}`;
    no-op when unchanged), `resetAvailability(tx, {all?, userId?, today?})` — **WI-016 day close calls it with
    `{all: true}`**; `AvailabilityRollover` (main.ts, every minute) journals the reset of stale FALSE flags.
  - `menu/menu.ts` + `menu.controller.ts` — `GET /menu?q` (array of `MenuItem`: item + category names/sort + active
    variants + `starting_price` + `orderable`; Kitchen: no `price`/`starting_price`; q < 2 chars → 400 SEARCH_TOO_SHORT),
    `PATCH /items/:id/availability` (If-Match, `{available_today}`), `POST /kitchen/items/:id/out-of-stock`. WI-013's
    category/item edits should emit `menu.availability_changed` too so menus refetch.
  - `menu/admin-menu.ts` + `admin-menu.controller.ts` (WI-013) — queue changes `createCategory`/`updateCategory`,
    `createItem`/`updateItem`, `createVariant`/`updateVariant`, `changeVariantPrice` (all emit `menu.availability_changed`
    with `source:'ADMIN'`; audit CREATE/UPDATE/DEACTIVATE/REACTIVATE/PRICE_CHANGE). Uniqueness checked in the queue,
    case-insensitive, over active and inactive rows: 409 DUPLICATE_NAME (category name_en; item name per category;
    variant name per item), DUPLICATE_SHORT_CODE; 400 SHORT_CODE_LENGTH (2–5), PRICE_NOT_POSITIVE; 422 PRICE_UNCHANGED.
    Ids `CAT-`/`ITM-`/`VAR-`/`PRC-NNNNNN` (counters CATEGORY/ITEM/VARIANT/PRICE_CHANGE; `nextId` skips ids already in
    the sheet). Variant PATCH drops `price` (`@ServerDerived`); price only changes via `changeVariantPrice` (variant +
    PriceChange + audit in one journal entry; OrderItems untouched). These sheets have no idempotency column, so the
    controller's `once()` keeps creating keys in memory 24 h per user (checked inside the queue change) — **WI-014
    can copy it for tables/users**. Tests: `test/admin-menu.e2e.spec.ts`. The auth matrix "Admin gets no 403 on /admin"
    now asserts not 401/403 (real routes answer 400/428 to empty bodies).
  - `admin/admin-staff.ts` + `admin-staff.controller.ts` (WI-014) — queue changes `createTable`/`updateTable` (ids `TBL-NNNNNN`
    counter TABLE; 409 DUPLICATE_TABLE_NUMBER case-insensitive over all tables; deactivating with an OPEN/BILLED order →
    409 TABLE_HAS_OPEN_ORDER `details.order`; emits `table.status_changed` + `dashboard.updated`), `createUser`/`updateUser`/
    `resetUserPin` (409 DUPLICATE_NAME among active users, ADMIN_PIN_CLASH, LAST_ADMIN; `{unlock:true}` (or `locked_until:null`
    / `failed_pin_count:0`) = unlock; audits CREATE/UPDATE/DEACTIVATE/REACTIVATE/UNLOCK/PIN_RESET, never pin_hash). Admin PIN
    clash: `adminPinClashes()` bcrypt-checks before the queue, the change re-checks (compareSync) only Admin hashes not
    pre-checked. `updateSettings` (PUT = replace; omitted gst_number/gst_rate_percent/shift_end_time → null; 400 INVALID_SETTING
    for rate outside 0–100 / >2 dp), `currentSettings(store)`. `SettingsController` = `GET /settings` (all roles).
    `common/memory-idempotency.ts` `MemoryIdempotency.once(sheet, scoped, res, create, replay?)` = the in-memory 24 h
    Idempotency-Key helper for sheets without a key column (use it for new creating POSTs; admin-menu still has its own copy).
    `nextId` and `diff` are exported from `menu/admin-menu.ts`. Tests: `test/admin-staff.e2e.spec.ts`.
  - `kitchen/kots.ts` + `kots.controller.ts` (WI-008) — `POST /orders/:id/kots` (body `{lines:[{variant_id, quantity 1–99,
    note ≤80}]}`, `runIdempotent('kots','idempotency_key')`, 400 EMPTY_CART, 422 ITEM_UNAVAILABLE `details.lines` =
    rejected lines only, BILLED → OPEN + BILL_REOPEN exception (reason_code NEW_ITEMS); response = Kot + `lines`),
    `GET /kitchen/kots` (`kitchenBoard(store, auth.now())`: hide_after null or in the future, oldest first, money-free
    `kitchenCard` built field by field — never spread a row into it; `late` = NEW/PREPARING and minutes_waiting >
    `late_kot_minutes`), `PATCH /kots/:id/status` (`KOT_NEXT` one step, 422 ILLEGAL_TRANSITION; SERVED sets served_at
    + hide_after = now + 10 min), `POST /order-items/:id/cancel` (`cancel_reason` or `reason`; KOT past NEW → Admin
    caller or consumed approval token + CANCEL_AFTER_START exception; all lines cancelled → KOT CANCELLED with
    hide_after; no ACTIVE line and no SUCCESS payment → order CANCELLED; returns orderView). **WI-010 calls
    `hideOrderKots(tx, orderId, userId)` when an order becomes PAID.** Ids: order items `OI-NNNNNN` (counter
    `ORDER_ITEM`), exceptions `EXC-NNNNNN` (counter `EXCEPTION`). `kot.created` carries the kitchen card.
  - `billing/bill.ts` (WI-009) — the billing service: `recomputeOrder(tx, order, patch, userId)` (patch applied, then
    `computeTotals` — **use it for every money change**, WI-010 payments/voids/close included), `writeException(tx, {...})`
    (`EXC-NNNNNN`, any `ExceptionType`), `OrderNotOpenError` (409 ORDER_NOT_OPEN), `tableStatusOf(order)`. `printBill`
    (expectVersion, 422 EMPTY_BILL without ACTIVE lines, bill_no from counter `BILL:<tx.businessDate()>` on first print,
    kept on reprint, audit BILL_PRINT/BILL_REPRINT) and `applyDiscount` (shared `DISCOUNT_TYPES` FIXED|PERCENT; percent
    converted once to a stored `discount_amount`, half-up to the paisa; 422 DISCOUNT_TOO_LARGE; above
    `Settings.discount_limit_amount` a non-Admin consumes an approval token; DISCOUNT exception + audit).
    `billing.controller.ts` — `POST /orders/:id/bill`, `POST /orders/:id/discount` (body `discount_type?`, `amount` |
    `percent`, `reason_code?`, `reason_text`|`reason`; one reason required → 400 REASON_REQUIRED; totals are
    `@ServerDerived`). Both return `orderView`. kots.ts imports these helpers.
  - `payments/payments.ts` (WI-010) — queue changes `recordPayment(tx, orderId, input, key, user)` (call via
    `runIdempotent('payments','idempotency_key')`; ids `PAY-NNNNNN` counter `PAYMENT`; balance rechecked with
    `computeTotals`; 422 OVERPAYMENT; zero balance → PAID + `hideOrderKots`; emits `payment.recorded`), `voidPayment`
    (non-Admin consumes approval; VOIDED row kept, `voided_by` = Admin id; PAID reopens to BILLED (bill_no) or OPEN,
    409 TABLE_BUSY if the table holds a new session; PAYMENT_VOID exception + VOID audit), `closeWithException`
    (shared `CLOSE_REASON_CODES`; CLOSED_EXCEPTION keeps its balance_due, CLOSE_WITH_BALANCE exception amount = balance),
    `logReceiptPrint` (audit RECEIPT_PRINT first, REPRINT after), `openBills(store)` (OPEN/BILLED with balance > 0, +
    `label`, `ready_to_close`), `changeDue`. `payments.controller.ts` = `GET /bills/open`, `POST /orders/:id/payments`
    (response adds `change_due`), `POST /payments/:id/void` (`void_reason`|`reason`), `POST /orders/:id/close-exception`,
    `POST /orders/:id/receipt-prints` (Idempotency-Key kept in memory 24 h per user, checked inside the queue change;
    returns orderView + `settings` + `print`). `emitOrderChange` is exported from `billing/bill.ts`.
    WI-016 day close lists OPEN/BILLED via `openBills`-like filters. **A PAID takeaway's KOTs are not hidden on
    payment** (`closeSession` skips `hideOrderKots`; REQ-041 paid-before-cooking) — handover hides them.
  - `orders/takeaway.ts` (WI-011) — `createTakeaway(tx, input, key, user)` (token from counter `TOKEN:<tx.businessDate()>`,
    409 TOKEN_EXISTS if that token is already on an order of the date; blank name/phone → null; CREATE audit; call via
    `runIdempotent('orders','client_request_id')`), `kitchenStatus(kots)` (NONE | least advanced non-cancelled KOT),
    `takeawayCard` / `activeTakeaways(store)` (TAKEAWAY, `handed_over_at` null, OPEN/BILLED/PAID; + `item_count`,
    `kitchen_status`, `paid` = status PAID, `ready_to_hand_over`), `handOver(tx, id, ifMatch, user)` (422 NOT_A_TAKEAWAY /
    ALREADY_HANDED_OVER / NOT_READY_FOR_HANDOVER `details.reasons` NOT_READY|NOT_PAID; READY KOTs → SERVED, all KOTs get
    hide_after; HANDOVER audit). Routes: `POST /orders/takeaway` in `orders.controller.ts`; `GET /takeaways` and
    `POST /takeaways/:id/handover` in `orders/takeaways.controller.ts`. Tests: `test/takeaway.spec.ts`, `test/takeaways.e2e.spec.ts`.
  - `dashboard/dashboard.ts` + `dashboard.controller.ts` (WI-012) — `GET /dashboard` = `{business_date, role, buttons, tiles,
    alert?}`. `buttons` = shared `DASHBOARD_BUTTONS` filtered by the role's PERMISSIONS (DINE_IN→openTableSession,
    TAKEAWAY→createTakeaway, KITCHEN→listKitchenKots, PAYMENT→listOpenBills; Kitchen gets only KITCHEN). `tiles`:
    `active_tables` (OPEN = same set as `GET /tables?status=OCCUPIED`), `ready_to_close_tables`, `pending_kots` (NEW/PREPARING),
    `ready_orders` (orders with a visible READY KOT); **Admin only** `todays_sales` (SUCCESS payments of today's business date)
    and `alert` (= `storage.saveAlert`). The keys are absent (not null) for other roles. Every write that changes these
    counts must `tx.emit('dashboard.updated', {})` (KOT status changes now do too). Tests: `test/dashboard.e2e.spec.ts`.
  - `day-close/day-close.ts` + `day-close.controller.ts` (WI-016) — `GET /admin/day-close` (`dayCloseSummary`: business date from
    `auth.now()`, `open_orders` = OPEN/BILLED of any date with `highlight:true`, `cash_total` = CASH SUCCESS of the business date,
    `can_close`), `POST /admin/day-close` (`closeDay`; Idempotency-Key kept in memory 24 h per user → 200 replay). The close runs
    inside `queue.exclusive`: 409 OPEN_ORDERS_REMAIN (`details.orders`) → `resetAvailability({all:true})` + DAY_CLOSE audit +
    `dashboard.updated` in one commit → `storage.save()` → `backups.dayCloseSnapshot()` (failure → 503 SNAPSHOT_FAILED) → archive.
  - `storage/archive.ts` (WI-016, REQ-108) — `MonthlyArchiver.archiveDue(commit, closedDate, …)`: months < closedDate's month still in
    live, plus its own month on the last day (`monthsToArchive`). `selectMonth` = orders by business_date month (+ merge/KOT closure),
    their kots/order_items/payments/exceptions, audit_log by created_at month (shared `ARCHIVED_SHEETS`). Writes
    `<DATA_DIR>/archive/YYYY-MM.xlsx` (later parts `YYYY-MM-<n>.xlsx`, `listArchiveParts`) as a full 15-sheet workbook (reference
    sheets copied, counters empty) via `writeArchiveFile` (0444, link — never replaces), re-reads and verifies counts/ids, then prunes
    live with `tx.remove` (journal op `t:'d'`, replayed at startup) + an ARCHIVE audit row. Resumable: rows already in a part with the
    same row_version are pruned without rewriting. **WI-015 reports read live + `listArchiveParts(storage.archiveDir, month)`
    (`readWorkbookFile`); for an id in several parts the later part wins.** `writeWorkbookFile` throws `ArchiveReadOnlyError` for
    archive names in `archive/` or any read-only target.
  - `WriteQueue.exclusive(async commit => …)` holds the queue for multi-step async work (day close; **WI-017's restore swap should use
    it** — "take write lock; queued writes wait"). Inside, use `commit(change)`, never `queue.run` (deadlock). `Tx.remove` is only for
    the archive prune (REQ-082: features never delete).
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
- `apps/pos-api/test/payments.e2e.spec.ts` (payments/voids/close/receipt over HTTP, `billedTable(lines)` helper) and
  `lunch-rush.e2e.spec.ts` (REQ-138/126: 10 HTTP clients with double taps, p95 send/pay < 1.5 s, crash + journal replay,
  no duplicate/mispriced rows). `support/pos-ops.ts` `recordPayment` now calls the real payment service.
- `apps/pos-api/test` — fixtures (`sampleData()`, `seededData()` = sample + counters, `tempDir()`), e2e
  specs, `support/pos-ops.ts` (stand-in order/KOT/payment changes for durability tests — replace with the
  real services' calls when they exist), `chaos.spec.ts` (spawns `support/chaos-writer.ts` through
  `support/ts-register.js` and kill -9s it), `lunch-rush.spec.ts`, `core.e2e.spec.ts` with
  `support/demo.controller.ts` (test-only routes showing the controller pattern: DTO + `@IdempotencyKey` +
  `runIdempotent` + `tx.create` + `tx.emit`; socket.io-client checks events), `support/save-bench.ts`.

- `test/support/sample-session.ts` — `sampleSessionData()`: the §7.6 billing fixture (REQ-100): Table 5
  `ORD-20261105-0005` (two KOTs, cancelled Sweet Lassi, split CASH 300 + UPI 220, subtotal 520), takeaway T-003
  `ORD-20261105-0008` (subtotal 260, a roti cancelled while NEW), Butter Chicken Half price change 200→220. Stored totals
  are 0 on purpose. `test/billing.spec.ts` drives the billing service on a raw `new Tx(new WorkbookStore(data), now)` with a
  fixed clock; `test/billing.e2e.spec.ts` covers the HTTP side.

- `apps/pos-api/test/tables.e2e.spec.ts` — the pattern for a feature e2e (seeded users, real logins, a `sendKot` helper
  writing KOTs/lines through the queue — switch it to the real send route once WI-008 exists).

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
