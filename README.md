# ReachInbox Email Job Scheduler

Production-oriented email scheduling monorepo for the ReachInbox assignment. It uses delayed BullMQ jobs backed by Redis, PostgreSQL/Prisma for durable state, Elasticsearch for search, Ethereal SMTP for test delivery, and a React/Vite dashboard.

## Stack

- **Backend:** TypeScript, Express, Prisma/PostgreSQL, BullMQ/Redis, Nodemailer/Ethereal, Elasticsearch, Zod
- **Frontend:** React, Vite, TypeScript, Tailwind-compatible PostCSS setup
- **Infrastructure:** Docker Compose with PostgreSQL, Redis, and Elasticsearch

## Quick start

Requirements: Node.js 20+, npm, and Docker Desktop/Engine.

```bash
npm install --ignore-scripts
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Set a long JWT_SECRET in backend/.env

docker compose up -d
npm run db:generate
npm run db:migrate
npm run seed:ethereal
npm run dev
```

The API runs at `http://localhost:4000`, the dashboard at `http://localhost:5173`, and health checks are available at `http://localhost:4000/health`.

For a production-style run:

```bash
npm run build
npm run start --workspace backend
npm run start:worker --workspace backend
npm run preview --workspace frontend
```

`npm install --ignore-scripts` is useful in restricted environments where the optional esbuild binary postinstall cannot run. In a normal environment, `npm install` is sufficient.

## Environment

Copy the two `.env.example` files. Backend settings include:

- `DATABASE_URL`, `REDIS_URL`, `ELASTICSEARCH_URL`
- `JWT_SECRET`, `FRONTEND_URL`, and `PORT`
- Google OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
- Slack OAuth: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`
- `WORKER_CONCURRENCY`
- `MIN_DELAY_BETWEEN_EMAILS_MS` (default: **2000 ms**)
- `MAX_EMAILS_PER_HOUR_PER_SENDER` (default: **100**)
- `RETRY_ATTEMPTS` and `RETRY_BACKOFF_MS`

The frontend uses `VITE_API_URL`, normally `http://localhost:4000/api`.

## OAuth setup

### Google

Create a Google OAuth 2.0 Web application and add this authorized callback URL:

```text
http://localhost:4000/api/auth/google/callback
```

Put the client ID and secret in `backend/.env`. The dashboard login button redirects to Google, then the API stores/upserts the user and sets an httpOnly JWT cookie.

### Slack

Create a Slack app with OAuth v2 and add this redirect URL:

```text
http://localhost:4000/api/slack/callback
```

Grant the scopes needed to post messages, set the Slack client values in `backend/.env`, and connect from the dashboard. A rate-limit notification looks up the current connection at notification time, so connecting later requires no redeploy.

## Ethereal setup

Ethereal provides safe test SMTP accounts and preview URLs. Run:

```bash
npm run seed:ethereal
```

The script creates multiple Ethereal sender records for the seeded user, prints SMTP credentials, and prints preview URLs for test messages. Configure the script's user ID/email as needed for your local account. Scheduled messages store `nodemailer.getTestMessageUrl()` in `previewUrl`.

## How scheduling works

`POST /api/emails/schedule` validates the subject, body, recipients, start time, delay, and hourly limit with Zod. It creates one durable `EmailJob` per recipient using a batch ID, assigns senders round-robin, indexes the records in Elasticsearch, and adds delayed BullMQ jobs with `jobId = emailId`.

The worker claims a job with an atomic Prisma transition:

```text
scheduled -> processing
```

Only the worker that updates one row can send. Already-sent jobs are skipped. Successful sends become `sent`; final failures become `failed` with the error. Elasticsearch is updated for status changes.

### Restart safety

Future delivery times live in PostgreSQL and delayed jobs live in Redis. On API/worker startup, reconciliation finds scheduled or stuck-processing database rows missing from Redis and re-adds them using the same email ID as the BullMQ job ID. This makes restarts recoverable and avoids duplicate queue entries.

### Throughput and rate limits

- Worker concurrency comes from `WORKER_CONCURRENCY`.
- BullMQ's global worker limiter enforces the configured minimum delay between sends.
- Redis sender/hour keys enforce the per-sender hourly limit across workers and instances. The batch `hourlyLimit` can override the configured default.
- Overflow is moved to the next UTC hour with a small position-based offset, then retried as a delayed job rather than dropped.
- The first hit for a sender/hour window is guarded by a Redis `SET NX` notification flag and can send a Slack alert.

A 1000-recipient batch is inserted and queued in bulk. It is then spread by the queue limiter and hourly windows rather than processed as an unbounded burst.

## API overview

- `GET /api/auth/google` and callback: Google login
- `GET /api/auth/me`, `POST /api/auth/logout`
- `POST /api/emails/schedule`
- `GET /api/emails/scheduled?page=1&pageSize=25`
- `GET /api/emails/sent?page=1&pageSize=25`
- `GET /api/emails/search?q=...`
- `GET /api/slack/connect`, callback, status, and disconnect
- `GET /admin/queues`: Bull Board queue dashboard when configured

All email and Slack routes require the authenticated httpOnly cookie.

## Dashboard

The frontend includes:

- Google sign-in gate and authenticated user header
- Scheduled/Sent tabs with pagination and Elasticsearch search
- Reusable loading states, empty state, status badges, and preview links
- Compose modal with recipient parsing, validation, deduplication, schedule time, delay, and hourly limit
- Slack connection action/status
- Responsive desktop/mobile layout

## Demo script

1. Start Docker and the API/worker with `npm run dev`.
2. Configure Google OAuth, sign in, and run `npm run seed:ethereal` for sender accounts.
3. Compose a campaign with several recipients and inspect **Scheduled emails**.
4. Stop and restart the worker. Reconciliation restores missing delayed jobs and delivery continues.
5. Run `npm run load-test` to enqueue 1000 emails with a low hourly limit. Watch jobs move into later hour windows and inspect Slack for the first limit notification.
6. Open the sent table and Ethereal preview links after delivery.

## Useful commands

```bash
npm run dev                         # API, worker, and Vite frontend
npm run build                       # Backend and frontend production builds
npm run db:generate                # Generate Prisma client
npm run db:migrate                 # Create/apply the development migration
npm run seed:ethereal               # Create Ethereal sender accounts
npm run load-test                  # Schedule a 1000-email rate-limit test
npm run dev:server --workspace backend
npm run dev:worker --workspace backend
```

## Assignment checklist

- [x] TypeScript Express API with Zod configuration and validation
- [x] Prisma models for users, senders, email jobs, and Slack connections
- [x] Durable delayed BullMQ jobs with email ID deduplication
- [x] Atomic database send claim and sent/failed state transitions
- [x] Configurable concurrency, minimum delay, retries, and hourly limits
- [x] Redis-backed rate limiting and delayed overflow rescheduling
- [x] Ethereal SMTP delivery and preview URL persistence
- [x] Elasticsearch indexing and full-text search endpoint
- [x] Google auth and protected API routes
- [x] Slack connect/status/disconnect flow and rate-limit notification hook
- [x] React/Vite dashboard, compose workflow, tables, search, pagination, loading and empty states
- [x] Docker Compose for PostgreSQL, Redis, and Elasticsearch
- [x] Seed and 1000-email load-test scripts

## Trade-offs and assumptions

This assignment intentionally uses Ethereal rather than a real production SMTP provider. OAuth credentials and Slack scopes are environment-specific and must be supplied by the deployer. The scheduler uses UTC hour windows for consistent multi-instance rate limiting. Database migrations are created with Prisma's development command; production deployments should apply committed migrations with `prisma migrate deploy`.
