# Email Job Scheduler

A production-grade email scheduling service and dashboard. Users log in with Google, upload a list of leads, and schedule emails to be sent at a specific time. Sending is driven by **BullMQ delayed jobs on Redis** (no cron), survives server restarts, never sends an email twice, and enforces per-sender hourly rate limits that are safe across multiple workers.

> Built as a full-stack assignment: TypeScript + Express + BullMQ + Redis + PostgreSQL + Elasticsearch on the backend, React + Tailwind on the frontend.

---

## Table of Contents

1. [Features](#features)
2. [Tech Stack](#tech-stack)
3. [Architecture Overview](#architecture-overview)
4. [How Scheduling Works](#how-scheduling-works)
5. [Persistence on Restart](#persistence-on-restart)
6. [Idempotency (No Duplicate Sends)](#idempotency-no-duplicate-sends)
7. [Concurrency, Delay and Rate Limiting](#concurrency-delay-and-rate-limiting)
8. [Behavior Under Load](#behavior-under-load)
9. [Slack Notifications](#slack-notifications)
10. [Project Structure](#project-structure)
11. [Data Model](#data-model)
12. [API Reference](#api-reference)
13. [Setup and Running](#setup-and-running)
14. [Environment Variables](#environment-variables)
15. [Ethereal Email Setup](#ethereal-email-setup)
16. [Google and Slack App Setup](#google-and-slack-app-setup)
17. [Demo Script](#demo-script)
18. [Requirements Checklist](#requirements-checklist)
19. [Assumptions, Shortcuts and Trade-offs](#assumptions-shortcuts-and-trade-offs)

---

## Features

### Backend
- Schedule emails via REST API, stored in PostgreSQL
- BullMQ delayed jobs on Redis for scheduling (no cron of any kind)
- Multiple senders via Ethereal SMTP, assigned round-robin
- Persistent scheduling: restart-safe, no lost or duplicated emails
- Idempotent sending (jobId dedupe + atomic DB status transition)
- Configurable worker concurrency
- Configurable minimum delay between sends (BullMQ limiter)
- Per-sender hourly rate limit backed by Redis (atomic Lua script)
- Rate-limited jobs are rescheduled to the next hour window, never dropped
- Live Slack notification when a sender's hourly limit is hit
- Elasticsearch indexing and full-text search of emails
- Bull Board live queue dashboard at `/admin/queues`
- Retries with exponential backoff, failed status with error recorded
- Startup reconciliation between DB and Redis

### Frontend
- Real Google OAuth login and logout
- Header with user name, email and avatar
- Tabs for Scheduled Emails and Sent Emails
- Compose New Email modal with CSV/text lead upload and detected-count display
- Start time, delay between emails and hourly limit inputs
- Connect / disconnect Slack
- Loading skeletons, empty states, pagination, search, toasts, status badges

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (backend and frontend) |
| API framework | Express.js |
| Queue / scheduler | BullMQ |
| Queue store / counters | Redis |
| Database | PostgreSQL with Prisma ORM |
| Search | Elasticsearch |
| Email transport | Nodemailer with Ethereal SMTP (fake SMTP) |
| Queue dashboard | Bull Board |
| Validation | Zod |
| Auth | Google OAuth 2.0, JWT in httpOnly cookie |
| Notifications | Slack OAuth v2 |
| Frontend | React, Vite, Tailwind CSS |
| Infra | Docker Compose (Redis, Postgres, Elasticsearch) |

---

## Architecture Overview

```
                        +----------------------+
                        |   React Dashboard    |
                        | (Vite + Tailwind)    |
                        +----------+-----------+
                                   | REST (cookie auth)
                                   v
+---------------------------------------------------------------+
|                    Express API Server                         |
|  Auth (Google) | Emails API | Slack OAuth | Bull Board        |
+-----+----------------+-------------------+-------------------+
      |                |                   |
      | Prisma         | add delayed jobs  | index / search
      v                v                   v
+-----------+     +-----------+      +----------------+
| PostgreSQL|     |   Redis   |      | Elasticsearch  |
| (source   |     | (BullMQ   |      | (searchable    |
|  of truth)|     |  jobs +   |      |  email index)  |
+-----+-----+     |  rate     |      +----------------+
      ^           |  counters)|
      |           +-----+-----+
      |                 | jobs due
      |                 v
      |        +--------------------+      +-------------------+
      +--------+   BullMQ Worker(s) +----->| Ethereal SMTP     |
   status      | concurrency,       |      | (Nodemailer)      |
   updates     | limiter, rate      |      +-------------------+
               | limiter, retries   |
               +---------+----------+
                         | on hourly limit hit
                         v
                  +---------------+
                  | Slack Webhook |
                  +---------------+
```

The API server and the worker are **separate processes** so workers can be scaled horizontally. PostgreSQL is the source of truth, Redis holds the queue and counters, and Elasticsearch is a read-optimized search index.

---

## How Scheduling Works

1. The client calls `POST /api/emails/schedule` with subject, body, recipients, start time, delay between emails and hourly limit.
2. The server validates the payload with Zod.
3. For each recipient it creates an `EmailJob` row in PostgreSQL with status `scheduled`.
4. Each email's send time is `scheduledAt = startTime + index * delayBetweenMs`.
5. A sender is assigned round-robin from the user's senders.
6. A BullMQ **delayed job** is added with `jobId = emailId` and `delay = max(0, scheduledAt - now)`. Jobs are added in bulk (`addBulk`) and rows are inserted in batches so large uploads stay fast.
7. Each email is also indexed into Elasticsearch.
8. When a job becomes due, a worker picks it up, sends it via Ethereal SMTP, stores the preview URL, and marks the row `sent` (or `failed`).

There is **no cron, no polling loop and no `setTimeout` scheduling**. Redis sorted sets inside BullMQ track when each job becomes due.

---

## Persistence on Restart

- Delayed jobs live in **Redis**, not in process memory, so stopping the server does not remove them.
- When the server or worker restarts, BullMQ resumes processing due jobs automatically.
- Emails already marked `sent` in PostgreSQL are never re-run, so nothing restarts from scratch.
- A **startup reconciliation** step finds DB rows with status `scheduled` (or stuck in `processing`) whose job is missing from Redis, for example after a Redis flush, and re-adds them. This is safe because of the `jobId` dedupe.
- Enable Redis persistence (AOF) in production so the queue survives a Redis restart. The provided `docker-compose.yml` enables it.

---

## Idempotency (No Duplicate Sends)

Three layers protect against double sends:

1. **`jobId = emailId`**: BullMQ ignores adding a second job with the same id.
2. **Atomic claim**: before sending, the worker runs
   `UPDATE email_jobs SET status='processing' WHERE id = ? AND status='scheduled'`
   and proceeds only if exactly one row was updated. A second worker that picks up the same job gets zero rows and skips.
3. **Terminal-state check**: if the status is already `sent`, the job exits immediately.

If a worker crashes mid-send, the reconciliation step returns stuck `processing` rows to a retriable state.

---

## Concurrency, Delay and Rate Limiting

### Worker concurrency
`WORKER_CONCURRENCY` sets how many jobs a worker processes in parallel. Safety under parallelism comes from the atomic DB claim and the Redis-atomic rate limiter.

### Minimum delay between sends
The BullMQ worker limiter is configured as:

```
limiter: { max: 1, duration: MIN_DELAY_BETWEEN_EMAILS_MS }
```

**Default: 2000 ms (minimum 2 seconds between sends)**, configurable via env. This mimics email provider throttling.

### Emails per hour (per sender)
- Key: `rl:{senderId}:{YYYYMMDDHH}` in Redis
- An **atomic Lua script** increments the counter and checks the limit in one step, so multiple workers or instances cannot over-send. The key expires after the hour window.
- Limit: `MAX_EMAILS_PER_HOUR_PER_SENDER` (the compose form's hourly limit can override it per batch). Nothing is hardcoded.
- When the limit is reached, the job is **not failed or dropped**. It is moved to the next hour window plus a small position-based offset, using `job.moveToDelayed(...)` and `DelayedError`. The DB `scheduledAt` is updated so the dashboard shows the new time. The offset keeps the original order roughly intact.

### Trade-offs
- Fixed hour windows are simple and cheap but allow a burst at a window boundary. A sliding window would be smoother but costs more Redis work.
- The BullMQ limiter is per worker queue, while the Lua counter is the true cross-instance guard for the hourly cap.

---

## Behavior Under Load

When 1000+ emails are scheduled for the same time:

- All rows are inserted in batches and jobs are added with `addBulk`, so the API responds quickly.
- The limiter spaces sends by the minimum delay and concurrency caps parallelism.
- Once a sender reaches its hourly cap, remaining jobs are pushed into the next hour windows in order. Nothing is dropped or permanently failed.
- Load is spread across senders by round-robin assignment.
- Run `npm run load-test` in `/backend` to schedule 1000 emails with a low hourly limit and watch the rescheduling in Bull Board.

---

## Slack Notifications

1. The user clicks **Connect Slack** and completes a real Slack OAuth v2 flow. A signed `state` parameter ties the callback to the user.
2. The backend stores the token/webhook per user in `SlackConnection`.
3. When a sender first hits its hourly limit in a window, the worker sends a **real Slack message** to that user's workspace. A Redis `SET NX` flag with TTL ensures one alert per sender per hour window.
4. If Slack is not connected, the alert is skipped silently with no crash. Because the connection is looked up at hit time, connecting later starts notifications with no redeploy.
5. Disconnect removes the stored credentials.

---

## Project Structure

```
email-job-scheduler/
├── docker-compose.yml
├── README.md
├── backend/
│   ├── prisma/schema.prisma
│   ├── scripts/loadTest.ts
│   ├── src/
│   │   ├── config/         # env validation (zod), constants
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── services/       # email, ethereal, slack, search, rate limiter
│   │   ├── queues/         # BullMQ queue definitions
│   │   ├── workers/        # email worker
│   │   ├── db/             # prisma client
│   │   ├── middleware/     # auth, error handling
│   │   ├── utils/
│   │   ├── types/
│   │   ├── server.ts       # API entry point
│   │   └── worker.ts       # worker entry point
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── components/ui/  # Button, Input, Modal, Table, Badge, Toast...
    │   ├── features/       # auth, emails, slack
    │   ├── hooks/
    │   ├── services/api.ts
    │   ├── types/
    │   └── pages/
    └── .env.example
```

---

## Data Model

- **User**: id, googleId, name, email, avatar, createdAt
- **Sender**: id, userId, email, smtpHost, smtpPort, smtpUser, smtpPass
- **EmailJob**: id, userId, senderId, toEmail, subject, body, scheduledAt, sentAt, status (`scheduled | processing | sent | failed`), attempts, error, previewUrl, batchId, createdAt
- **SlackConnection**: id, userId (unique), accessToken/webhookUrl, channel, teamName, createdAt

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/auth/google` | Start Google OAuth |
| GET | `/api/auth/google/callback` | OAuth callback, sets cookie, redirects to dashboard |
| GET | `/api/auth/me` | Current user |
| POST | `/api/auth/logout` | Log out |
| POST | `/api/emails/schedule` | Schedule a batch of emails |
| GET | `/api/emails/scheduled` | Paginated scheduled emails |
| GET | `/api/emails/sent` | Paginated sent/failed emails |
| GET | `/api/emails/search?q=` | Elasticsearch search |
| GET | `/api/slack/connect` | Start Slack OAuth |
| GET | `/api/slack/callback` | Slack OAuth callback |
| GET | `/api/slack/status` | Slack connection status |
| DELETE | `/api/slack/disconnect` | Remove Slack connection |
| GET | `/admin/queues` | Bull Board dashboard |
| GET | `/health` | Health check |

Example schedule request:

```json
{
  "subject": "Hello",
  "body": "Hi there!",
  "recipients": ["a@example.com", "b@example.com"],
  "startTime": "2026-10-01T10:00:00.000Z",
  "delayBetweenMs": 2000,
  "hourlyLimit": 50
}
```

---

## Setup and Running

### Prerequisites
- Node.js 20+
- Docker and Docker Compose

### 1. Clone and start infrastructure

```bash
git clone <your-repo-url>
cd email-job-scheduler
docker compose up -d        # Redis, PostgreSQL, Elasticsearch
```

### 2. Backend

```bash
cd backend
cp .env.example .env        # fill in values
npm install
npx prisma migrate dev
npm run seed:senders        # creates Ethereal sender accounts
npm run dev:server          # API server on :4000
npm run dev:worker          # worker (separate terminal)
# or: npm run dev           # runs both
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev                 # http://localhost:5173
```

### 4. Useful URLs
- Dashboard: http://localhost:5173
- Bull Board: http://localhost:4000/admin/queues
- API health: http://localhost:4000/health

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Example |
|---|---|---|
| `PORT` | API port | `4000` |
| `DATABASE_URL` | PostgreSQL URL | `postgresql://user:pass@localhost:5432/scheduler` |
| `REDIS_URL` | Redis URL | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | Elasticsearch URL | `http://localhost:9200` |
| `JWT_SECRET` | JWT signing secret | `change-me` |
| `FRONTEND_URL` | Frontend origin (CORS + redirects) | `http://localhost:5173` |
| `GOOGLE_CLIENT_ID` | Google OAuth client id | |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | |
| `GOOGLE_CALLBACK_URL` | Google redirect URI | `http://localhost:4000/api/auth/google/callback` |
| `SLACK_CLIENT_ID` | Slack app client id | |
| `SLACK_CLIENT_SECRET` | Slack app client secret | |
| `SLACK_REDIRECT_URI` | Slack redirect URI | `http://localhost:4000/api/slack/callback` |
| `WORKER_CONCURRENCY` | Parallel jobs per worker | `5` |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | Minimum gap between sends | `2000` |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Hourly cap per sender | `50` |
| `JOB_ATTEMPTS` | Retry attempts | `3` |
| `JOB_BACKOFF_MS` | Base backoff delay | `5000` |

### Frontend (`frontend/.env`)

| Variable | Description | Example |
|---|---|---|
| `VITE_API_URL` | Backend base URL | `http://localhost:4000` |

---

## Ethereal Email Setup

Ethereal is a fake SMTP service: emails are accepted but never delivered, and each gets a preview URL.

1. Run `npm run seed:senders` in `/backend`. It calls `nodemailer.createTestAccount()` to create several Ethereal accounts and saves them as `Sender` rows.
2. The credentials are logged to the console. You can also create accounts manually at https://ethereal.email/create and insert them.
3. After each send, the worker stores `nodemailer.getTestMessageUrl(info)` as `previewUrl`, shown in the Sent Emails table.
4. Log in at https://ethereal.email/login with a sender's credentials to see its inbox.

---

## Google and Slack App Setup

### Google OAuth
1. Go to Google Cloud Console, then APIs & Services, then Credentials.
2. Create an **OAuth client ID** (Web application).
3. Add the authorized redirect URI: `http://localhost:4000/api/auth/google/callback`.
4. Copy the client id and secret into `backend/.env`.

### Slack OAuth
1. Create an app at https://api.slack.com/apps.
2. Under OAuth and Permissions, add the redirect URL `http://localhost:4000/api/slack/callback`.
3. Add the `incoming-webhook` scope (and `chat:write` if posting via token).
4. Copy the client id and secret into `backend/.env`.
5. Slack requires HTTPS redirect URLs for some setups. Use a tunnel such as ngrok during local development.

---

## Demo Script

1. **Login** with Google and show the header (name, email, avatar).
2. **Connect Slack** from the dashboard.
3. **Compose**: upload a CSV, show the detected count, set start time, delay and hourly limit, then Schedule.
4. Show the **Scheduled Emails** tab, then watch emails move to **Sent Emails** with preview links.
5. **Restart scenario**: schedule emails a couple of minutes ahead, stop the server and worker, start them again, and show the emails still send at the correct time with no duplicates.
6. **Rate limiting**: run the load test (or use a low hourly limit), show jobs rescheduled into the next hour in Bull Board, and show the **Slack message** arriving.

---

## Requirements Checklist

| Requirement | Status |
|---|---|
| Accept email schedule requests via API | Done |
| Store in relational DB (PostgreSQL) | Done |
| BullMQ delayed jobs, no cron | Done |
| Ethereal SMTP with multiple senders | Done |
| Elasticsearch indexing and search | Done |
| Live BullMQ dashboard | Done (Bull Board) |
| Survives restarts, no duplicates | Done |
| Configurable worker concurrency | Done |
| Minimum delay between sends | Done (default 2 s) |
| Per-sender hourly limit, Redis-backed, multi-worker safe | Done |
| Reschedule instead of drop on limit | Done |
| Slack OAuth and live notification on limit hit | Done |
| Idempotency | Done |
| Google OAuth login, header user info, logout | Done |
| Dashboard with Scheduled and Sent tabs | Done |
| Compose with CSV upload, start time, delay, hourly limit | Done |
| Loading, empty and error states | Done |
| Typed, reusable frontend components | Done |

---

## Assumptions, Shortcuts and Trade-offs

- Ethereal is used for all sending, so no real emails are delivered.
- Hour windows are fixed clock hours rather than sliding windows.
- SMTP credentials are stored in the database in plain text for simplicity. In production they should be encrypted or held in a secrets manager.
- The Slack token/webhook is stored per user without encryption for the same reason.
- One Redis instance is assumed. Redis Cluster would need hash-tag key design for the Lua script.
- The hourly limit entered in the compose form is applied per batch and takes precedence over the env default for that batch.
- Elasticsearch is a secondary index. If it is unavailable, scheduling and sending continue and PostgreSQL remains the source of truth.

---

## License

MIT
