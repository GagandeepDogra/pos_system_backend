# Dhaba POS

Point-of-sale system for one dhaba (roadside restaurant). This repository holds the backend, **pos-api**, plus
the types shared with the web app.

There is no database. All data lives in one Excel workbook, `dhaba-pos.xlsx`, in the data folder, and the
owner can open it and back it up. The server:

- takes an exclusive lock on the data folder at startup and refuses to start if another server holds it;
- loads all 15 worksheets into indexed memory and serves reads from memory, so it keeps answering even
  while the file is open or locked by another program;
- validates the workbook on load (exact sheet set, columns, types, allowed status values, unique ids,
  references, schema version) and refuses to start on an invalid file;
- saves the workbook atomically (temp file + rename) with protected sheets: bold frozen headers, locked ID
  columns, dropdown validation on status/enum columns, and a sheet password.

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
| `DATA_DIR` | `./data` | folder for the workbook and lock file (relative to where the server starts) |
| `WORKBOOK_SHEET_PASSWORD` | `dhaba-pos` | password protecting the workbook's sheets |

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
`{"status":"green","workbook":{"loaded":true}}`. On first start in an empty folder, the server creates a fresh
workbook. If another server already runs on the same data folder, the second one prints
`pos-api refused to start: ...` and exits with code 1.

## Test

```bash
npm test
```

This runs all tests with coverage and fails if the storage or billing code drops below 80% coverage.
