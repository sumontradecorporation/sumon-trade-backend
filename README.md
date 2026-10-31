# Sumon Trade ERP API

The REST API: Node.js, Express 5, TypeScript, Mongoose 9 (MongoDB) and Zod 4. Setup, sign-in accounts
and the full documentation are in the [root README](../README.md).

```bash
cp .env.example .env          # set the JWT secrets (32+ characters each)
npm install
npm run seed -- --demo        # super admin plus a demo company with a year of data
npm run dev                   # http://localhost:5000, health check at /api/health
npm test                      # API and unit tests against the database sumon_trade_test
npx tsc --noEmit              # type check
npm run build && npm start    # production
```

Other commands: `npm run seed -- --reset --demo` rebuilds the demo company, and
`npm run reset-password -- <email or phone> <new password>` sets a password from the server.

## Layout

| Folder | Contents |
|--------|----------|
| `src/config` | Environment (validated with Zod, refuses example secrets in production), MongoDB connection, logger |
| `src/core` | Errors, HTTP helpers, permissions and default roles, settings defaults, document types (`TXN_CONFIG`), encryption of stored secrets, shared Zod fields |
| `src/middleware` | Authentication, company context and permission guard, uploads, validation, error envelope |
| `src/models` | Mongoose schemas (see [docs/DATA_MODEL.md](../docs/DATA_MODEL.md)) |
| `src/modules/<area>` | One router per API area; transactions and reports also have their service and engine here |
| `src/services` | Ledger recalculation, numbering, approvals, audit log, notifications, mail and IMAP, automations, Excel, new company defaults |
| `src/jobs` | Scheduled reminders, daily summary, low stock alerts and inbox sync |
| `src/scripts` | Seed and console password reset |
| `test` | `node:test` suites |

Every endpoint and its permission is listed in [docs/API.md](../docs/API.md); the design is explained
in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
