# Dhaba POS

Point-of-sale system for one dhaba (roadside restaurant). This repository holds the backend, **pos-api**, plus
the types shared with the web app.

There is no database. All data lives in one Excel workbook, `dhaba-pos.xlsx`, in the data folder, and the
owner can open it and back it up. The server:

- takes an exclusive lock on the data folder at startup and refuses to start if another server holds it;
- loads all 15 worksheets into indexed memory and serves reads from memory, so it keeps answering even
  while the file is open or locked by another program;
- validates the workbook on load (exact sheet set, columns, types, allowed status values, unique ids,
  references, schema version) and upgrades an older schema version on a copy, keeping the original in
  `backups/`;
- applies every change through one write queue, one change at a time, and writes each change as one line
  to the journal file `dhaba-pos.journal` (flushed to disk with fsync) before it answers. If the server
  crashes or loses power before the workbook is saved, it replays the journal at the next start, so no
  confirmed order, KOT or payment is lost. A change cut off mid-write is either fully there or absent;
- answers `503` on every route until loading, migration and journal replay have finished;
- if the workbook cannot be read, keeps running with writes blocked: `/api/v1/health` turns red and offers
  the newest valid backup in `backups/` plus the journal changes made after it (see "Recovering a corrupt
  workbook");
- saves the workbook atomically (temp file + rename) with protected sheets: bold frozen headers, locked ID
  columns, dropdown validation on status/enum columns, and a sheet password. Saves are coalesced: at most
  one every 2 seconds, always within 2 seconds of the last change. If a save fails (disk full, file locked
  by another program), the previous file stays intact, `/api/v1/health` turns red with the alert "Saving
  problem, call owner", and the save is retried 2 seconds later;
- if the journal cannot be written, the change is undone in memory and the request answers `503
  SAVE_FAILED` ("Saving problem, call owner"), so nothing is confirmed that is not on disk;
- gives every row `created_at`/`updated_at` (ISO 8601, `+05:30`), `created_by`/`updated_by` and a
  `row_version` that goes up by 1 on each update. Updates need an `If-Match: <row_version>` header (`428`
  without it); a stale version answers `409` with the current record in `details.current`;
- generates all ids itself from the Counters sheet (e.g. `ORD-20261105-0008`, token `T-007`); orders, KOTs
  and tokens get a `business_date` that rolls over at the configured reset time (04:00 by default), so a
  1 a.m. order belongs to the previous trading day;
- creating requests carry an `Idempotency-Key` header; repeating a key returns the stored record (`200`)
  instead of creating a second one;
- validates request bodies (unknown fields are rejected with `400`), strips leading `=`, `+`, `-` and `@`
  from text so the workbook cannot run formulas when opened in Excel, and answers every error with
  `{code, message_en, message_hi, details}`;
- pushes small Socket.IO events (path `/socket.io`) after each confirmed change: `kot.created`,
  `kot.status_changed`, `order.updated`, `table.status_changed`, `payment.recorded`,
  `menu.availability_changed`, `dashboard.updated`. A rejected change sends nothing;
- signs staff in with a PIN: `GET /api/v1/auth/staff` lists active staff (id, name, role) for the login
  tiles without a token, and `POST /api/v1/auth/login` with `{"user_id","pin"}` returns a JWT. Five wrong
  PINs in a row lock that user for 5 minutes (`423`, even with the right PIN; each wrong PIN answers `401`
  with the tries left). A session lasts 12 hours, or until the shift end set in Settings if that comes
  first; a kitchen device (`"device_role":"KITCHEN"` with a Kitchen user) is not logged out at shift end;
- requires `Authorization: Bearer <token>` on every other route (`401` without it, when it has expired,
  or when the user was deactivated or had their PIN reset) and enforces the three roles (Admin, Cashier,
  Kitchen) on the server: a role that may not call a route gets `403 ACCESS_DENIED`, recorded in the
  Audit Log sheet. `/api/v1/admin/...` is Admin-only;
- lets an Admin approve a cashier's action on the cashier's phone: `POST /api/v1/auth/approvals` with the
  Admin's PIN returns a single-use approval token, valid for 2 minutes, that the action sends as
  `X-Approval-Token`; the Admin is recorded as approver. Each user sets their own language (`en`/`hi`)
  with `PATCH /api/v1/me/language`;
- runs the table grid and dine-in sessions (all need a login):
  - `GET /api/v1/tables` lists active tables in number order, each with a status worked out from its
    open order (never stored): `AVAILABLE` (no open order), `OCCUPIED` (order open) or `READY_TO_CLOSE`
    (bill printed, awaiting payment), plus the order id, minutes open and the running bill. Kitchen
    users get no amounts. `?area=Hall` shows one area (tables without an area appear only in the full
    list); `?status=OCCUPIED` filters by status;
  - `POST /api/v1/orders/dine-in` with `{"table_id", "guest_count"?}` and an `Idempotency-Key` header
    opens a session (`201`). Repeating the same key returns the same order (`200`); a table that already
    has an open order answers `409 TABLE_BUSY` with that order in `details.order`. Admin and Cashier only;
  - `GET /api/v1/orders/{id}` returns the order with its payments and its lines grouped under the KOT
    that sent them. A Cashier can open every open session but only their own closed orders;
  - `POST /api/v1/orders/{id}/move` with `{"table_id"}` moves a session to a free table, and
    `POST /api/v1/orders/{id}/merge` with `{"source_order_id"}` moves another open table's lines onto
    this order (the other order is closed and points to this one; its table becomes free; a source with
    payments is refused). Both need the order's `row_version` in `If-Match` and are recorded in the
    Audit Log sheet;
- serves the food-selection menu and today's item availability (all need a login):
  - `GET /api/v1/menu` lists the active items of active categories (category order, then name), each with
    its category names, veg/non-veg type, optional photo, active variants with prices, the starting price
    (cheapest active variant) and `orderable` (available today and has an active variant). Kitchen users
    get no prices. `?q=dal` searches English names, Hindi names and short codes; fewer than 2 letters
    answers `400 SEARCH_TOO_SHORT`;
  - `PATCH /api/v1/items/{id}/availability` with `{"available_today": true|false}` and the item's
    `row_version` in `If-Match` switches an item on or off for today (any role; it never changes whether
    the item is active on the menu);
  - `POST /api/v1/kitchen/items/{id}/out-of-stock` marks an item out of stock for today (Kitchen and
    Admin only; a Cashier gets `403`). Connected phones receive a `menu.availability_changed` event with a
    Hindi/English alert for the cashier;
  - every item switched off is available again at the start of the next business day (the day rolls
    over at the settings' token reset time, 04:00 by default);
- serves the web app's static build (when `WEB_DIR` is set) on every path outside `/api` and `/socket.io`;
  an unknown `/api/...` path answers `404` with code `NOT_FOUND`.

### Automatic backups

During open hours the server copies the saved workbook into `backups/` every 15 minutes, but only when
something changed since the last copy, so no change waits more than 15 minutes to reach a backup. Each
copy is named by its time and reason, e.g. `backups/snapshot-20261105-143000-auto.xlsx`, and is re-read
after copying to make sure it is a valid workbook. Retention: every snapshot of the last 30 days is
kept; for older days one snapshot per day is kept (the day-close one when there is one) for 1 year;
older snapshots are deleted. Other files in `backups/` (such as pre-migration copies) are never deleted.
`/api/v1/health` reports the last snapshot and the last snapshot error in its `backups` block.

Order lines copy the item name, variant name, food type and unit price at the moment of ordering, so later
menu edits never change old bills. PINs are stored only as bcrypt hashes.

So far the HTTP API has the health endpoint, `GET /api/v1/health` (no login needed), sign-in and
approvals, the table grid and dine-in session routes, the menu and availability routes above, plus the Socket.IO channel.

## Stack

- Node.js 20, TypeScript, NestJS 10, class-validator, Socket.IO
- ExcelJS for the workbook, bcryptjs for PIN hashes
- Jest for tests (80% coverage required on the storage and billing code)
- npm workspaces: `apps/pos-api` (the server) and `packages/shared` (enums and data types shared with the web app)

## Requirements

- Node.js 20 or newer and npm
- No database or other service

Environment variables (see `.env.example`; all are optional):

| variable | default | meaning |
|---|---|---|
| `DEPLOY_PROFILE` | `lan` | `lan` (counter PC on the dhaba Wi-Fi) or `cloud` (VPS); see [docs/deployment.md](docs/deployment.md) |
| `PORT` | `3000` (`443` in the cloud profile) | listening port |
| `HOST` | LAN: this PC's first private IPv4 (else `127.0.0.1`); cloud: `0.0.0.0` | interface to bind. The LAN profile refuses `0.0.0.0` and public addresses |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | empty | certificate and key (PEM) to serve HTTPS. Required in the cloud profile (Let's Encrypt); optional on the LAN (mkcert) |
| `HTTP_REDIRECT_PORT` | empty | with TLS: a plain-HTTP port that only redirects to HTTPS (e.g. `80`) |
| `CORS_ORIGIN` | empty | cloud profile, required: the one `https://` origin allowed to call the API from a browser |
| `OFFSITE_BACKUP_DIR` | empty | folder on another machine (mounted) that gets a fresh snapshot every night. Required in the cloud profile |
| `OFFSITE_BACKUP_TIME` | `02:30` | IST time of the nightly off-server copy |
| `DATA_DIR` | `./data` | folder for the workbook, journal, `backups/` and lock file (relative to where the server starts) |
| `WORKBOOK_SHEET_PASSWORD` | `dhaba-pos` | password protecting the workbook's sheets |
| `SNAPSHOT_OPEN_HOURS` | empty (all day) | IST open hours for automatic snapshots, `HH:mm-HH:mm`, e.g. `10:00-23:30` or `18:00-02:00` |
| `JWT_SECRET` | empty | secret (32+ characters) that signs login tokens. Never stored in the workbook or backups |
| `JWT_SECRET_FILE` | `pos-api-jwt.secret` next to the data folder | used when `JWT_SECRET` is empty; created with a random secret (mode 600) on first start. Must be outside the data folder |
| `WEB_DIR` | empty (none) | folder with the web app's static build (`index.html` at its root), served on non-API paths |

## Install

```bash
npm install
```

## Build and run

```bash
npm run build
# once, on a fresh data folder (server stopped): the first Admin, who then adds the other staff
DATA_DIR=./data ADMIN_NAME=Owner ADMIN_PIN=1234 npm run create-admin
DATA_DIR=./data HOST=127.0.0.1 PORT=3000 npm start
```

Log in:

```bash
curl http://localhost:3000/api/v1/auth/staff
curl -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"user_id":"USR-000001","pin":"1234"}'
```

(Without `HOST`, the server binds to this machine's LAN address, so other devices on the Wi-Fi reach it
at `http://<LAN IP>:3000`.) The server makes the data folder readable only by its own account (mode
700 on Linux).

The API answers at `http://localhost:3000/api/v1`, and `curl http://localhost:3000/api/v1/health` returns
`{"status":"green","workbook":{"loaded":true,...},"journal":{"last_seq":0,...},"queue":{"depth":0},"backups":{"last_snapshot":null,...}}`
(`503` while the server is still loading). On first start in an empty folder, the server creates a fresh
workbook and journal. If another server already runs on the same data folder, or the journal is damaged
in the middle, the server prints `pos-api refused to start: ...` and exits with code 1.

## Deploying

The server runs in one of two profiles. The **LAN profile** (default) runs on a counter PC, binds only
to the local network, and works with no internet. The **cloud profile** runs on a VPS: it serves HTTPS
only, rate-limits login to 10 attempts per minute per IP, allows browser calls only from the app's
origin, and copies a backup off the server every night. Installers register the server to start on
boot: `deploy/windows/install-service.ps1` (Windows service via NSSM) and `deploy/linux/install.sh`
(PM2). Before going live, review the settings:

```bash
npm run build
DEPLOY_PROFILE=cloud TLS_CERT_FILE=... TLS_KEY_FILE=... CORS_ORIGIN=https://pos.example.in \
  OFFSITE_BACKUP_DIR=/mnt/offsite npm run check:deploy
```

It prints each failure and exits with code 1 if the configuration is not acceptable (for example a
cloud profile without an off-server backup folder). The full steps, router checklist and the
`pos.local` name and certificate setup are in [docs/deployment.md](docs/deployment.md).

## Recovering a corrupt workbook

When `dhaba-pos.xlsx` cannot be read, the server logs the problem, blocks writes, and `/api/v1/health`
returns `"status":"red"` with a `recovery` block naming the newest valid backup and how many journal
changes would be replayed on top of it. To accept it, stop the server and run:

```bash
DATA_DIR=./data npm run recover
```

The corrupt file is kept as `dhaba-pos.xlsx.corrupt-<time>`, the backup plus the journal becomes the live
workbook, and the server can be started again. Without a valid backup the command exits with an error and
changes nothing.

## Test

```bash
npm test
```

This runs all tests with coverage and fails if the storage or billing code drops below 80% coverage. The
tests include a crash test that kills a writing server process with `kill -9` at random points and checks
that every confirmed change is present exactly once after restart, and a lunch-rush simulation with
double-tapped requests and a mid-service price change.

To time a full save of a synthetic 15 MB workbook (a busy month of orders):

```bash
npm run bench:save -w @dhaba/pos-api
```

It prints the workbook size and the time of three saves; the target is under 1 second on the counter PC.
