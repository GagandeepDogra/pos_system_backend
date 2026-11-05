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
  columns, dropdown validation on status/enum columns, and a sheet password.

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

So far the HTTP API only has the health endpoint, `GET /api/v1/health`.

## Stack

- Node.js 20, TypeScript, NestJS 10
- ExcelJS for the workbook, bcryptjs for PIN hashes
- Jest for tests (80% coverage required on the storage and billing code)
- npm workspaces: `apps/pos-api` (the server) and `packages/shared` (enums and data types shared with the web app)

## Requirements

- Node.js 20 or newer and npm
- No database or other service

Environment variables (see `.env.example`; all are optional):

| variable | default | meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | interface to bind |
| `DATA_DIR` | `./data` | folder for the workbook, journal, `backups/` and lock file (relative to where the server starts) |
| `WORKBOOK_SHEET_PASSWORD` | `dhaba-pos` | password protecting the workbook's sheets |
| `SNAPSHOT_OPEN_HOURS` | empty (all day) | IST open hours for automatic snapshots, `HH:mm-HH:mm`, e.g. `10:00-23:30` or `18:00-02:00` |

## Install

```bash
npm install
```

## Build and run

```bash
npm run build
DATA_DIR=./data PORT=3000 npm start
```

The API answers at `http://localhost:3000/api/v1`, and `curl http://localhost:3000/api/v1/health` returns
`{"status":"green","workbook":{"loaded":true,...},"journal":{"last_seq":0,...},"queue":{"depth":0},"backups":{"last_snapshot":null,...}}`
(`503` while the server is still loading). On first start in an empty folder, the server creates a fresh
workbook and journal. If another server already runs on the same data folder, or the journal is damaged
in the middle, the server prints `pos-api refused to start: ...` and exits with code 1.

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
