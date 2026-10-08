# CommentBridge

CommentBridge is a TypeScript/NestJS REST API that reads normalized comments for
a logical social-media post and sends replies through platform adapters. It covers
multi-publication reads, stable cursor pagination, parent-scoped idempotency,
delivery lifecycle tracking, RFC 7807 errors, Swagger, PostgreSQL tests, and
deterministic Instagram and LinkedIn mocks.

## Implemented requirements

- Logical `Post` records separated from per-account `PostPublication` records.
- One normalized, self-referencing `Comment` table for inbound comments and
  outbound replies.
- Reads from `PUBLISHED` publications only, with platform and direct-parent
  filters and reply counts under the same visibility rule.
- Parent-scoped idempotent replies with a database uniqueness constraint.
- Durable `PENDING` delivery jobs, leased worker claims, attempt history, bounded
  retries, and `UNKNOWN` quarantine for ambiguous outcomes.
- A standalone delivery worker process with PostgreSQL-backed heartbeat state, and
  operational delivery status, queue statistics, and database-conditional retry.
- Explicit dead-letter state and transactional audit history for manual actions.
- Platform adapter registry with deterministic Instagram and LinkedIn mocks and
  platform-specific message limits.
- RFC 7807-style errors, safe NestJS HTTP exception handling, validation details,
  request correlation IDs, and Swagger/OpenAPI.
- Restricted PostgreSQL roles for the API and the worker, separate from the schema owner,
  with externally supplied credentials and no published database port in the application
  stack.
- Finite, database-enforced statement and lock budgets on every runtime connection.
- Unit, PostgreSQL integration, and E2E tests with an explicit destructive-reset
  guard.

## Architecture

The controller owns HTTP concerns, `CommentsService` owns workflow and invariants,
and ports isolate persistence and platform behavior. Prisma and provider details
do not cross into the public API contract.

```mermaid
flowchart LR
  Client --> Controller[REST controller]
  Controller --> Service[CommentsService]
  Service --> Repository[CommentRepository]
  Repository --> PostgreSQL[(PostgreSQL)]
  Worker[Delivery worker process] --> PostgreSQL
  Worker --> Registry[Adapter registry]
  Registry --> Instagram[Instagram mock]
  Registry --> LinkedIn[LinkedIn mock]
```

## Runtime architecture

CommentBridge is two independently runnable processes that share only PostgreSQL:

```text
API process (node dist/main.js)          Delivery worker process (node dist/worker.js)
  Nest HTTP server                         Nest application context, no HTTP listener
  controllers, operator auth, Swagger      ReplyDeliveryWorker (claim, send, reconcile)
  CommentsService, repositories            DeliveryWorkerRuntime (register, poll, heartbeat)
  queues replies, reports queue + workers  repositories, platform adapters
            \                                       /
             +------------ PostgreSQL ------------+
               delivery queue, attempts, worker heartbeats
```

Request serving and asynchronous delivery have different lifecycles and scaling: the
API scales with traffic and must stay responsive, while the worker scales with
provider latency and is bounded by provider timeouts. The API only ever queues work;
**it never runs the worker**, so an API deployment can never start a duplicate
delivery loop by accident. `DELIVERY_WORKER_ENABLED` no longer exists (it is ignored
with a startup warning); whether a worker runs is decided only by whether you start
the worker process.

`WorkerModule` loads just the database, platform adapters, delivery repositories,
and the worker runtime: no controllers, Swagger, request middleware, or operator
authentication. `AppModule` (the API) and `WorkerModule` share the Prisma
configuration, repositories, and delivery settings through `DeliveryPersistenceModule`
but each process builds its own Prisma client and connection pool.

Run both locally (two terminals, PostgreSQL up and migrated):

```bash
pnpm dev                  # API with reload
pnpm start:worker:dev     # worker with reload
```

Production uses the compiled output and the same artifact for both:

```bash
pnpm build
pnpm start                # API:    node dist/main.js
pnpm start:worker         # worker: node dist/worker.js
```

### Production deployment

The `Dockerfile` produces one runtime image used with two commands. The application
stack is its own Compose file, [docker-compose.app.yml](docker-compose.app.yml): PostgreSQL, a
one-shot `migrate` job, the API, and the delivery worker. **It publishes no database
port** (PostgreSQL is reachable only by the other services on the Compose network);
only the API publishes a port.

```bash
# Passwords come from your environment, a .env file next to the compose file, or a
# secret manager. Compose refuses to start when one is missing. Use URL-safe values.
export POSTGRES_ADMIN_PASSWORD=$(openssl rand -hex 24)
export COMMENTBRIDGE_API_DB_PASSWORD=$(openssl rand -hex 24)
export COMMENTBRIDGE_WORKER_DB_PASSWORD=$(openssl rand -hex 24)

docker compose -f docker-compose.app.yml up -d --build            # runs migrate first
docker compose -f docker-compose.app.yml up -d --scale delivery-worker=3
```

`api` publishes a port and its healthcheck calls `GET /health/ready` (readiness, never
delivery backlog; see _Health endpoints_). `delivery-worker` publishes no port and has no
container healthcheck: its liveness is the heartbeat reported by
`GET /api/v1/deliveries/stats` and judged by `GET /api/v1/deliveries/health`, and the
restart policy covers crashes. Its
`stop_grace_period` (30s) exceeds the provider timeout so the job in flight can
finish on `SIGTERM`. Each runtime container receives only its own role's
`DATABASE_URL` plus the `DELIVERY_*` and `DB_*` settings; only the API needs
`OPERATOR_API_KEYS` and `PORT`. The `migrate` job is the only container that holds the
admin password; it builds from a target that includes the Prisma CLI because the runtime
image omits dev dependencies.

### Database roles

Three database identities, so that a compromised or buggy process cannot change the
schema or reach more data than its job needs:

| Identity               | Used by                                              | Can                                                                                                                           |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `postgres` (owner)     | `pnpm db:migrate`, `db:provision-roles`, `db:seed`   | Everything: it owns the schema. Never given to the API or worker.                                                             |
| `commentbridge_api`    | the API (`DATABASE_URL`)                             | Read all tables; insert and update comments and deliveries (queue a reply, retry, dead-letter); insert audit rows. No delete. |
| `commentbridge_worker` | the worker (`WORKER_DATABASE_URL` or `DATABASE_URL`) | Claim and complete deliveries, write attempts and its own heartbeat, prune history. Cannot create comments or deliveries.     |

Neither runtime role is a superuser, owns an object, can create a table (permanent or
temporary), schema, function, trigger, role or database, drop or alter anything, or
use `COPY ... PROGRAM`. Migration `20261008000000_runtime_database_roles` creates the
roles (`NOLOGIN`) and the grants; the exact privilege matrix is repeated in
`test/integration/database-roles.integration-spec.ts`, which fails when a table exists
that the matrix does not decide, so a later migration cannot leave one ungoverned.
Two further guards: operator audit rows (`ReplyDeliveryManualAction`) cannot be updated
by any role (the worker holds `UPDATE` only because its retention query takes row locks),
and each role has role-level statement, lock and idle-in-transaction timeouts as a
ceiling for any client that sets none.

A migration cannot carry a password, so `pnpm db:provision-roles` applies the login and the
password you supply (`COMMENTBRIDGE_API_DB_PASSWORD`, `COMMENTBRIDGE_WORKER_DB_PASSWORD`)
and is also how you rotate them. It refuses short, placeholder, or identical
passwords. The Prisma CLI reads `MIGRATION_DATABASE_URL` (`directUrl`) and refuses to
run without it, so a runtime URL cannot be used to migrate by accident. The runtime
never reads it.

Known residual risk: PostgreSQL lets any role change its own password and nothing can
revoke that. A compromised runtime role could lock itself out; `pnpm db:provision-roles`
repairs it. It cannot widen its privileges.

### Database budgets

Every runtime connection (API and worker, pooled connections, raw queries, and interactive
transactions) is opened with PostgreSQL startup parameters
`statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`, so the
**server** cancels an over-budget statement and releases its locks. A JavaScript timer
that only stops waiting cancels nothing; readiness therefore runs its `SELECT 1` under a
`SET LOCAL` statement budget, and the 2-second `Promise.race` that remains only bounds the
HTTP response when the pool cannot hand out a connection at all.

| Variable                    | Default | Meaning                                                            |
| --------------------------- | ------- | ------------------------------------------------------------------ |
| `DB_STATEMENT_TIMEOUT_MS`   | `5000`  | Longest any statement may run, lock waits included                 |
| `DB_LOCK_TIMEOUT_MS`        | `2000`  | Longest a statement waits for one lock; below the statement budget |
| `DB_TRANSACTION_TIMEOUT_MS` | `5000`  | Longest interactive transaction; at least the statement budget     |

Startup fails with an error naming the variable if they are missing, non-positive, above one
hour, or inconsistent. They also fix the minimum lease:
`DELIVERY_LEASE_DURATION_MS` must exceed `DELIVERY_PROVIDER_TIMEOUT_MS` plus
`DB_TRANSACTION_TIMEOUT_MS`, so a worker that is slow to record a delivery the provider
accepted still owns the job. If recording fails (a lock budget expires, say), the transaction
rolls back and the job stays `PROCESSING` until its lease expires, then reconciliation
resolves it by provider lookup: a persistence failure after provider acceptance is never a
blind redelivery.

The expired-lease sweep waits for row locks like any update, so a lock held by someone else
makes it fail after `DB_LOCK_TIMEOUT_MS`. The drain logs `delivery.lease-sweep-failed` and
carries on, because claims skip locked rows; the next drain retries the sweep. A lock that
stays held shows up as that log line repeating and as `UNKNOWN` age in operational health.

## Quick start

Requirements: Node.js 22 or 24, pnpm 11, Docker, and Docker Compose.

```bash
cp .env.example .env
# Fill in the three *_PASSWORD values (openssl rand -hex 24) and put the same passwords
# into the three database URLs below them.
pnpm install
docker compose up -d --wait postgres      # published on 127.0.0.1 only
pnpm db:deploy                            # migrate as the owner, then create the role logins
pnpm db:seed                              # seeds as the owner
pnpm dev                                  # API, as commentbridge_api
pnpm start:worker:dev                     # delivery worker, as commentbridge_worker (second terminal)
```

The development database is bound to `127.0.0.1` (use `127.0.0.1`, not `localhost`, in
URLs: on Windows `localhost` tries `::1` first and every new connection pays a timeout).
The API only queues replies; they are delivered while the worker process runs.
PowerShell users can replace the first command with
`Copy-Item .env.example .env`. The API runs at `http://localhost:3000`, Swagger UI
at `http://localhost:3000/api/docs`, and OpenAPI JSON at
`http://localhost:3000/api/docs-json`.

The seed prints the logical post ID. Stable example IDs are:

- post: `11111111-1111-4111-8111-111111111111`
- Instagram comment: `44444444-4444-4444-8444-444444444441`
- second Instagram comment: `44444444-4444-4444-8444-444444444442`

To create a clean submission archive from committed files only:

```bash
git archive --format=zip --output=commentbridge-submission.zip HEAD
```

## API examples

List comments from published publications. Optional query parameters are
`platform`, `parentId`, `cursor`, and `limit` (default 20, maximum 100).

```bash
curl "http://localhost:3000/api/v1/posts/11111111-1111-4111-8111-111111111111/comments?platform=INSTAGRAM&limit=20"
```

Each comment exposes local and provider time:

```json
{
  "createdAt": "2026-08-04T09:00:00.000Z",
  "remoteCreatedAt": "2026-08-04T10:00:00.000Z"
}
```

`createdAt` is local persistence time. `remoteCreatedAt` is the provider timestamp
and may be `null` for `PENDING` or `FAILED` replies.

Create a reply with a key scoped to this parent comment:

```bash
curl -i -X POST \
  "http://localhost:3000/api/v1/comments/44444444-4444-4444-8444-444444444441/replies" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-reply-001" \
  -d '{"message":"Thank you for your feedback!"}'
```

A new reply is durably queued and returns `202`. A replay remains `202` while
delivery is pending and returns `200` after delivery reaches `SENT`.

The delivery operations endpoints (status, retry, dead-letter, and stats) require an
operator API key, `Authorization: Bearer <key>`; see
[Operator authentication](#operator-authentication). The examples below assume
`OPERATOR_KEY` holds a configured key.

Inspect the delivery state, its 20 most recent attempts, and its 20 most recent
manual actions:

```bash
curl "http://localhost:3000/api/v1/replies/<reply-id>/delivery" \
  -H "Authorization: Bearer $OPERATOR_KEY"
```

Conditionally schedule a failed reply for another attempt:

```bash
curl -i -X POST \
  "http://localhost:3000/api/v1/replies/<reply-id>/delivery/retry" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPERATOR_KEY" \
  -d '{"reason":"Provider incident resolved."}'
```

Retry returns `202` only for `FAILED`. Concurrent or otherwise invalid transitions
return `409`. In particular, `UNKNOWN` cannot be retried through this endpoint and
must remain on the provider-reconciliation path.

Move a queued, retrying, failed, or unknown delivery to the terminal dead-letter
state:

```bash
curl -i -X POST \
  "http://localhost:3000/api/v1/replies/<reply-id>/delivery/dead-letter" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPERATOR_KEY" \
  -d '{"reason":"Provider cannot resolve this delivery."}'
```

Manual retry and dead-letter transitions store the authenticated operator ID, the
normalized reason, previous state, resulting state, and timestamp atomically.

### Operator authentication

Operators authenticate with static API keys configured as
`OPERATOR_API_KEYS=operatorId=key[,operatorId=key]`. Each key must be at least 32
characters (`openssl rand -hex 32`), and keys and operator IDs must be unique. A
request is attributed to the operator that owns the matching key; a client-supplied
`X-Operator-Id` header is ignored. Keys are held only as SHA-256 digests, compared in
constant time, and never logged or echoed in errors. Missing, malformed, or unknown
credentials all return the same `401` problem response with
`WWW-Authenticate: Bearer`.

The endpoints fail closed: with `OPERATOR_API_KEYS` empty, every operations request is
rejected (a startup warning says so), and malformed settings stop startup. Comment
and reply endpoints and `/health` stay open. This is deliberately not user
authentication or tenant authorization: there are no roles, per-endpoint scopes, or
key rotation workflow. Rotate by adding the new key, deploying, then removing the
old one.

## Database model

`Post` is platform-neutral content. `PostPublication` represents delivery to one
`SocialAccount` and owns the platform post ID and status. Inbound comments and
outbound replies share `Comment`; `parentId` links a reply to its direct parent.

PostgreSQL constraints enforce account/publication uniqueness, external-comment
uniqueness per publication, reply idempotency per parent, valid direction/delivery
combinations, and a parent for every outbound reply. The application always
derives a reply's `postPublicationId` from the loaded parent, while a composite
foreign key on `(parentId, postPublicationId)` prevents every database writer from
linking comments across publications. Additional checks require provider identity
for inbound and sent comments and keep publication status aligned with
`publishedAt`.

Reads order by `paginationAt, id`, a persisted timestamp fixed when the comment is
inserted (the provider timestamp if the row has one, otherwise the local creation time) and
immutable afterwards: a database trigger derives it on insert and rejects any change, for
every role. `remoteCreatedAt` stays provider metadata and is still recorded when delivery
succeeds. Ordinary indexes on `(postPublicationId | parentId, paginationAt DESC, id DESC)`
serve the listing; required uniqueness indexes remain.

## Platform adapter extension

`SocialPlatformAdapter` contains platform identity, capabilities, reply delivery,
and authoritative reply lookup. Tests use Jest spies rather than adding
instrumentation to the port.

To add a platform:

1. Add its domain and Prisma enum value with a migration.
2. Implement the adapter, capabilities, and safe provider-error mapping.
3. Register the adapter in `PlatformsModule`.

No platform-specific branch is needed in `CommentsService`.

## Idempotency

The database unique key is `(parentId, idempotencyKey)`, and every lookup uses the
same pair. The same key and normalized message on the same parent returns the
stored reply without calling the provider again; a different message returns
`409`. The same key can be used independently on another parent. The unique index
closes concurrent-create races, so only one durable delivery job is created. A
concurrent duplicate request receives the existing `PENDING` reply with `202`.
After successful delivery, the same request is returned as an idempotent `200`
replay.

The worker claims due jobs with `FOR UPDATE SKIP LOCKED` and a lease. Explicitly
retryable provider failures use bounded exponential backoff and reuse the same
provider idempotency key. Unknown exceptions, timeouts, expired leases, and a crash
after provider acceptance are quarantined as delivery `UNKNOWN`; the public reply
remains `PENDING` until provider lookup resolves it. A found reply completes the
original attempt, an authoritative absence permits bounded retry, and an
inconclusive lookup remains quarantined with backoff. Exactly-once delivery still
depends on provider-side idempotency and authoritative reconciliation support.

## Worker lease ownership

Every claim (normal delivery or `UNKNOWN` reconciliation) stamps the delivery with a
fresh random `leaseToken` next to `leaseUntil`, and returns it in the work item.
Every completion (`SUCCEEDED`, `RETRY`, `FAILED`, `UNKNOWN`) is a single
conditional update on `id`, `status = PROCESSING`, the attempt number, **and the
exact token**, and clears the lease and token when it leaves `PROCESSING`.

The token matters because a lease can expire, be reconciled to `UNKNOWN`, and be
re-claimed for lookup under the _same attempt number_. Status and attempt number
alone would then match the new owner, letting a stalled worker overwrite its
result. A stale worker now fails with an internal `DeliveryLeaseLostError`
before any delivery, comment, or attempt row changes; the worker logs it and
discards the result. The new owner's provider lookup finds a reply the stale
worker really sent, so it is still delivered once. The token is never exposed by
the API. PostgreSQL enforces that `PROCESSING` rows have both `leaseUntil` and
`leaseToken`, and all other states have neither.

`reconcileExpiredLeases` is one SQL statement that moves only rows that are still
`PROCESSING` and expired, closes their open attempt, and returns the number
actually transitioned. A provider lookup during reconciliation is not a new
outbound attempt, so `attemptCount` is unchanged.

## Worker scheduling and lifecycle

Each poll runs one bounded drain: expired-lease maintenance once, then up to
`DELIVERY_MAX_JOBS_PER_TICK` jobs from two queues, with progress guaranteed for both under
every accepted configuration:

- **Two or more slots:** `UNKNOWN` reconciliation gets up to the smaller of
  `DELIVERY_MAX_RECONCILIATIONS_PER_TICK` and (slots - 1) first, so normal
  `PENDING`/`RETRY` deliveries always keep at least one slot, even when the quota equals the
  whole budget and `UNKNOWN` work is endlessly due.
- **One slot:** the queues take alternate drains (reconciliation first), and the turn only
  advances when a job was served.
- **Spare capacity is never wasted:** a slot one queue does not use goes to the other, and
  reconciliation may exceed its quota with slots delivery left idle.

Every job takes a fresh clock reading, so a lease never starts in the past.

The worker process starts with `NestFactory.createApplicationContext` (no HTTP
listener), registers itself, then polls and heartbeats until it receives a signal.
A fatal startup error (invalid configuration, database unreachable) exits non-zero.

On `SIGTERM` or `SIGINT` the runtime stops the poll, heartbeat, and retention
timers, starts no further jobs or cleanup batches, and waits for the job (bounded by
the provider timeout) and any single cleanup batch already in flight before the database connection closes and the process exits. A second signal
exits immediately. A hard kill is still safe: the unfinished lease expires into
`UNKNOWN` and is resolved by provider lookup. Shutdown writes nothing to shared
state; the worker simply goes `STALE` when its heartbeat ages out.

| Variable                                | Default | Meaning                                                                  |
| --------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `DELIVERY_POLL_INTERVAL_MS`             | `1000`  | Delay between drains                                                     |
| `DELIVERY_LEASE_DURATION_MS`            | `30000` | Must exceed the provider timeout plus `DB_TRANSACTION_TIMEOUT_MS`        |
| `DELIVERY_PROVIDER_TIMEOUT_MS`          | `10000` | Per provider call or lookup                                              |
| `DELIVERY_MAX_ATTEMPTS`                 | `5`     | Attempts before `FAILED`                                                 |
| `DELIVERY_BASE_RETRY_DELAY_MS`          | `1000`  | First backoff; doubles per attempt                                       |
| `DELIVERY_MAX_RETRY_DELAY_MS`           | `60000` | Backoff cap; at least the base delay                                     |
| `DELIVERY_MAX_JOBS_PER_TICK`            | `10`    | Jobs per drain                                                           |
| `DELIVERY_MAX_RECONCILIATIONS_PER_TICK` | `3`     | Reconciliation slots; at most the job budget (normal delivery keeps one) |
| `DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS` | `10000` | How often a worker refreshes its heartbeat                               |
| `DELIVERY_WORKER_STALE_AFTER_MS`        | `30000` | Heartbeat age after which a worker is `STALE`; must exceed the interval  |

Invalid values stop startup of the API and the worker with an error naming the
variable (never its value). The API reads `DELIVERY_WORKER_STALE_AFTER_MS` to classify
workers, so give both processes the same value.

## Delivery observability

`GET /api/v1/deliveries/stats` is a read-only operations view with two parts, both
read from PostgreSQL. It requires an operator API key like the other operations
endpoints.

- `queue`: durable, cross-instance state from one SQL statement: row counts for
  every delivery status, how long the oldest _due_ `PENDING`/`RETRY` delivery
  (`oldestDueDeliveryAgeMs`) and the oldest due `UNKNOWN` delivery
  (`oldestDueReconciliationAgeMs`) have waited, and `expiredLeases`, the
  `PROCESSING` rows past their lease that maintenance has not yet reconciled.
  Rising lag or a persistent `expiredLeases` means workers are down or behind.
- `workers`: the state of every worker process, shared through the
  `DeliveryWorkerInstance` table. Worker counters used to live in the memory of the
  process serving the request; once the worker became its own process the API could
  only have reported zeros, so that model was replaced rather than kept.

```json
{
  "queue": { "countsByStatus": { "PENDING": 0 }, "expiredLeases": 0, "...": "..." },
  "workers": {
    "staleAfterMs": 30000,
    "active": 1,
    "stale": 0,
    "instances": [
      {
        "instanceId": "worker-host-41-9f3a1c2e",
        "status": "ACTIVE",
        "startedAt": "2026-10-03T12:00:00.000Z",
        "lastHeartbeatAt": "2026-10-03T12:05:08.000Z",
        "lastDrain": {
          "completedAt": "2026-10-03T12:04:59.000Z",
          "durationMs": 18,
          "processed": 4,
          "succeeded": 3,
          "retry": 1,
          "failed": 0,
          "unknown": 0,
          "leaseLost": 0,
          "expiredLeases": 0
        }
      }
    ]
  }
}
```

**Worker runtime state.** Each worker process generates an `instanceId` once at
startup (host, pid, random suffix) and keeps one row for its lifetime, so any number
of workers coexist without sharing a row. The id is only for operators; it is
unrelated to a delivery's `leaseToken`, which protects ownership of one delivery and
is never exposed. A worker registers on startup and then refreshes
`lastHeartbeatAt` every `DELIVERY_WORKER_HEARTBEAT_INTERVAL_MS` from a timer that is
independent of the poll loop, so a slow provider call does not look like a dead
worker. A drain is persisted only when it did work (a delivery, a reconciliation, or
expired-lease maintenance); idle polls cost no writes, so `lastDrain` is the most
recent drain that did something, and an old `lastDrain` beside a fresh heartbeat
means an idle queue.

**ACTIVE and STALE.** A worker is `ACTIVE` while its last heartbeat is at most
`DELIVERY_WORKER_STALE_AFTER_MS` old and `STALE` afterwards. Heartbeat age is the only
source of truth: a crashed process cannot record that it stopped, so there is no
`STOPPED` state and a graceful shutdown just ages out. Timestamps come from each
process clock, so keep host clocks roughly synchronized (skew must stay well below
the stale threshold). Zero `active` workers with growing `queue` lag means nothing
is delivering.

Rows whose heartbeat is older than the retention window (24 hours, or twice the
stale threshold if larger) are not reported and are pruned when any worker starts.
That is the only cleanup; it keeps the table at roughly one row per recent restart
until the general retention task covers delivery history. The `instances` list is
capped at the 50 most recent heartbeats while `active` and `stale` count every row.

Inside the worker process, `DeliveryWorkerMetrics` still keeps per-process counters
(drains, drain failures, job outcomes by kind). They are not exposed through the API
because they describe one process only; the worker logs its drain and failure totals
at shutdown.

A drain that did any work also writes one JSON log line
(`{"event":"delivery.drain","durationMs":…,"expiredLeases":…,"reconciled":…,"delivered":…}`);
idle drains are silent. The worker logs `delivery-worker.starting`,
`delivery-worker.started`, `delivery-worker.shutdown-started`, and
`delivery-worker.shutdown-complete` with its `workerInstanceId`; heartbeats are not
logged. Messages, provider payloads, and credentials are never logged.

## Health endpoints

Three different questions get three different answers. Mixing them is how an outage
turns into a restart loop, so they are separate on purpose.

| Endpoint                        | Question                               | Auth         | Depends on                   | Result                                  |
| ------------------------------- | -------------------------------------- | ------------ | ---------------------------- | --------------------------------------- |
| `GET /health/live`              | Is this process alive?                 | none         | nothing                      | always `200 {"status":"UP"}`            |
| `GET /health/ready`             | Can this API instance serve traffic?   | none         | PostgreSQL (`SELECT 1`, 2 s) | `200 READY` / `503 NOT_READY`           |
| `GET /health`                   | Legacy readiness check (compatibility) | none         | PostgreSQL (`SELECT 1`, 2 s) | unchanged body: `ready` / `not_ready`   |
| `GET /api/v1/deliveries/health` | Is asynchronous delivery keeping up?   | operator key | PostgreSQL (two small reads) | `200` + state in JSON / `503` if unread |

```json
{ "status": "READY", "checks": { "database": "UP" } }
```

**Compatibility.** `GET /health` has always run `SELECT 1` and answered `503` when the
database was down, so it already behaved like readiness and Docker health checks rely
on it. It is kept exactly as it was (same body, same status codes); only the query now
has the same 2-second bound as `/health/ready`. New probes should use `/health/live`
(restart decisions) and `/health/ready` (traffic decisions). None of the three public
endpoints knows anything about the delivery queue, and none returns secrets, connection
strings or stack traces.

The Compose `api` healthcheck calls `/health/ready`. The worker has no HTTP listener and
no container healthcheck by design: its health is its heartbeat, judged by the
operational endpoint below.

### Operational health

`GET /api/v1/deliveries/health` answers "is delivery actually working?", which can be
false while the API is perfectly ready. It needs an operator API key (it is not public)
and reports a deterministic `HEALTHY` / `DEGRADED` / `CRITICAL` status: the worst of
four signals, with no scores or weights. Every non-healthy state lists the issues that
caused it.

```json
{
  "status": "CRITICAL",
  "evaluatedAt": "2026-10-03T13:00:00.000Z",
  "signals": {
    "workers": {
      "status": "CRITICAL",
      "required": true,
      "active": 0,
      "stale": 1,
      "lastHeartbeatAt": "2026-10-03T12:41:10.000Z"
    },
    "queue": {
      "status": "DEGRADED",
      "oldestDueAgeMs": 95000,
      "warnAfterMs": 60000,
      "criticalAfterMs": 300000
    },
    "unknown": {
      "status": "HEALTHY",
      "count": 0,
      "oldestAgeMs": null,
      "warnAfterMs": 300000,
      "criticalAfterMs": 1800000
    },
    "retention": {
      "status": "HEALTHY",
      "enabled": true,
      "lastSuccessAt": "2026-10-03T12:30:02.000Z",
      "lastFailureAt": null,
      "lastFailureCode": null,
      "overdueAfterMs": 10800000
    }
  },
  "issues": [
    {
      "code": "NO_ACTIVE_WORKER",
      "severity": "CRITICAL",
      "signal": "workers",
      "message": "No active delivery workers"
    },
    {
      "code": "QUEUE_LAG",
      "severity": "DEGRADED",
      "signal": "queue",
      "message": "Oldest due delivery has waited past the lag warning threshold"
    }
  ]
}
```

**HTTP status.** `200` whenever the state could be evaluated, including `CRITICAL`; the
state is in the body. A backlog is not a reason for a load balancer or orchestrator to
restart anything, and a polling tool must be able to read the detail. A non-2xx response
(`503`, `application/problem+json`, code `DELIVERY_HEALTH_UNAVAILABLE`) means the state
could not be evaluated because PostgreSQL could not be read. A failed read is never
turned into an empty, healthy-looking result.

**Stable issue codes.** Match on `code`; `message` is for humans. Severity is a separate
field, so there is one code per condition.

| Code                       | Signal      | Raised when                                                                              | Severity                                     |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| `NO_ACTIVE_WORKER`         | `workers`   | No worker heartbeat within `DELIVERY_WORKER_STALE_AFTER_MS` (and workers are required)   | `DEGRADED` inside the grace, then `CRITICAL` |
| `QUEUE_LAG`                | `queue`     | Oldest _due_ `PENDING`/`RETRY` delivery waited ≥ warn / ≥ critical                       | `DEGRADED` / `CRITICAL`                      |
| `UNKNOWN_AGE`              | `unknown`   | Oldest unresolved `UNKNOWN` outcome is ≥ warn / ≥ critical old                           | `DEGRADED` / `CRITICAL`                      |
| `RETENTION_OVERDUE`        | `retention` | No successful retention run for ≥ interval × multiplier                                  | `DEGRADED`                                   |
| `RETENTION_RECENT_FAILURE` | `retention` | The latest retention outcome (across workers) is a failure newer than the latest success | `DEGRADED`                                   |

Every threshold is inclusive: a value equal to the threshold already has that severity.

- **Worker availability.** Idle and busy workers both heartbeat, so `active > 0` means a
  worker is running and `0` means none is; "never seen a worker" and "all workers stale"
  are told apart by `stale` and `lastHeartbeatAt`. With no active worker the signal is
  `DEGRADED` until `DELIVERY_HEALTH_NO_WORKER_GRACE_MS` has elapsed since the last worker
  went stale, or since this API process started if none was ever recorded, then
  `CRITICAL`. The API's own start time is part of the clock so that bringing the whole
  stack up (or restarting the API) does not page anyone before a worker can register.
  **Stale rows alone never change the status while another worker is active:** a clean
  shutdown and a crash are indistinguishable, and every deploy leaves a stale row for up
  to 24 hours, so counting them would make routine deploys look like incidents. They are
  reported in `workers.stale` for humans. A deployment that intentionally runs no worker
  can set `DELIVERY_HEALTH_WORKER_REQUIRED=false`.
- **Queue lag.** `now − min(nextAttemptAt)` over `PENDING`/`RETRY` rows whose
  `nextAttemptAt <= now`. A retry scheduled for the future is backoff working as
  designed, not lateness, so it is never counted. The lookup is an index probe on
  `(status, nextAttemptAt)`, constant cost however large the backlog.
- **UNKNOWN.** `UNKNOWN` means a provider call may or may not have happened, so what
  matters is how long that has gone unresolved, not how many there are (the count is
  reported as context). The age is measured from `startedAt` of the attempt that produced
  the ambiguity (the delivery's latest attempt), not from `updatedAt`: every reconciliation
  try refreshes `updatedAt` and `nextAttemptAt`, which would make a delivery that has been
  stuck for hours look new. A delivery leaves the set when reconciliation resolves it.
- **Retention.** Each worker records its latest retention outcome on its own
  `DeliveryWorkerInstance` row (timestamps, duration, deleted counts, and for failures a
  short error class name; never messages, stacks, or row contents). Health takes the newest
  success and newest failure across all retained worker rows. A failure newer than the
  newest success is `RETENTION_RECENT_FAILURE` and is cleared by any later success, from any
  worker. With no success at all, a worker that has been up for the whole overdue window
  counts as overdue; a younger one does not, because retention runs immediately at worker
  start. Nothing is reported when retention is disabled.

**Lease-loss rate is deliberately not a signal.** `LEASE_LOST` outcomes exist only in
per-process counters and in each worker's single most recent drain; neither can answer
"how many in the last N minutes, cluster-wide" without a new event table. That is more
infrastructure than this task warrants, so lease loss stays a logged metric.

| Variable                                       | Default   | Meaning                                                         |
| ---------------------------------------------- | --------- | --------------------------------------------------------------- |
| `DELIVERY_HEALTH_WORKER_REQUIRED`              | `true`    | `false` stops "no worker" being an issue                        |
| `DELIVERY_HEALTH_NO_WORKER_GRACE_MS`           | `60000`   | Time with no worker before `DEGRADED` becomes `CRITICAL` (0 ok) |
| `DELIVERY_HEALTH_QUEUE_LAG_WARN_MS`            | `60000`   | Oldest due delivery age that is `DEGRADED`                      |
| `DELIVERY_HEALTH_QUEUE_LAG_CRITICAL_MS`        | `300000`  | Oldest due delivery age that is `CRITICAL` (above warn)         |
| `DELIVERY_HEALTH_UNKNOWN_AGE_WARN_MS`          | `300000`  | Oldest unresolved `UNKNOWN` age that is `DEGRADED`              |
| `DELIVERY_HEALTH_UNKNOWN_AGE_CRITICAL_MS`      | `1800000` | Oldest unresolved `UNKNOWN` age that is `CRITICAL` (above warn) |
| `DELIVERY_HEALTH_RETENTION_OVERDUE_MULTIPLIER` | `3`       | Overdue after this many retention intervals (greater than 1)    |

Everything else is intentionally fixed: the readiness query timeout (2 s) and the 24-hour
worker-row window the stale/retained logic already used. Invalid or inconsistent values
stop startup, like the other delivery settings. The API and worker read the same
variables, so set them identically on both (as Compose does).

**Alert integration.** CommentBridge exposes state; it does not send notifications and
contains no Slack, email, or paging integration. An external monitor polls the endpoint
with an operator key and alerts on the body:

```bash
curl -fsS -H "Authorization: Bearer $OPERATOR_API_KEY" \
  http://localhost:3000/api/v1/deliveries/health | jq '{status, issues}'
```

Alert on `status != "HEALTHY"` or on specific `issues[].code`, and treat a non-2xx or
a timeout as its own alert ("health cannot be read"). Keep the key in the monitor's
secret store; do not put it in a public dashboard or a URL. The endpoint is cheap
(two small reads, no table scans), so a 10–30 second poll is fine. The API logs
`delivery-health.degraded`, `delivery-health.critical`, and `delivery-health.recovered`
(status and issue codes only) when the status it observes changes. That state is
process-local and only advances when someone polls, so it is a log aid, not alert
deduplication.

## Data retention

Delivery data falls into four classes with different lifetimes:

| Data                                                    | Class               | Retention                                               |
| ------------------------------------------------------- | ------------------- | ------------------------------------------------------- |
| `Comment` (inbound comments and replies)                | Domain state        | Kept                                                    |
| `ReplyDelivery`                                         | Domain state        | **Kept for the lifetime of its reply; never pruned**    |
| `ReplyDeliveryAttempt`                                  | Operational history | Pruned after 90 days; newest 3 per delivery always kept |
| `ReplyDeliveryManualAction` (retry / dead-letter audit) | Audit history       | Pruned after 365 days                                   |
| `DeliveryWorkerInstance`                                | Ephemeral runtime   | Pruned by the worker at startup (24 h), unchanged       |

`ReplyDelivery` is kept because the API depends on it: `GET /api/v1/replies/:id/delivery`
returns 404 without the row, and the row holds the current status, attempt counter and
last error. Only its child history is pruned, so every delivery endpoint behaves the
same after pruning; the attempt and manual-action lists in the delivery response are
simply shorter. The attempt list is therefore recent history, not a permanent log, and
`attemptCount` (a counter on the delivery, not a row count) still reports the true total.

**Attempts** are deleted only when all of these hold in the deleting statement:

- the attempt finished (`finishedAt` set; an open attempt is never touched) before the cutoff;
- its delivery is `SUCCEEDED`, `FAILED`, or `DEAD_LETTERED`. `PENDING`, `RETRY`,
  `PROCESSING` and `UNKNOWN` deliveries keep everything, because `UNKNOWN` reconciliation
  rewrites the attempt numbered `attemptCount`;
- at least `DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY` newer attempts of the same
  delivery exist, so the latest outcomes survive however old they are. `FAILED` can still
  be retried by an operator; a retry only creates attempt `attemptCount + 1` and reads
  nothing older.

**Manual actions** are deleted once older than their own, longer, cutoff and only for
settled deliveries. No state transition reads them. They are written once and never
updated by the application; only retention removes them.

Pruning cannot reuse an attempt number: the next number comes from
`ReplyDelivery.attemptCount`, which is incremented when a delivery is claimed.

Retention runs inside the **worker** process, on its own timer (once at startup, then
every `DELIVERY_RETENTION_INTERVAL_MS`), independent of polling: a busy queue does not
prune more often and an idle one still prunes. Any number of workers may run it. Each pass
deletes at most `DELIVERY_RETENTION_BATCH_SIZE` rows per statement, at most 100
statements per table per run, and rows another transaction holds are skipped rather than
waited for, so concurrent passes simply find less to do. A pass logs
`{"event":"delivery-retention.completed","deletedAttempts":…,"deletedManualActions":…,"batchCount":…,"durationMs":…,"attemptCutoff":…,"manualActionCutoff":…,"capped":…}`
when it deleted something (`debug` level when it found nothing) and
`delivery-retention.failed` with the error name on failure. Row contents are never
logged. Each pass's outcome (time, duration, counts, and on failure the error class name)
is also stored on the worker's own `DeliveryWorkerInstance` row so that
`GET /api/v1/deliveries/health` can report when retention last succeeded or failed and
whether it is overdue (_Health endpoints_). It is the latest outcome per worker, not a
history table. There is no dry-run mode and no HTTP endpoint; to pause pruning set
`DELIVERY_RETENTION_ENABLED=false`.

| Variable                                       | Default   | Meaning                                                  |
| ---------------------------------------------- | --------- | -------------------------------------------------------- |
| `DELIVERY_RETENTION_ENABLED`                   | `true`    | `false` disables pruning entirely                        |
| `DELIVERY_ATTEMPT_RETENTION_DAYS`              | `90`      | Age after which finished attempts may be pruned          |
| `DELIVERY_MANUAL_ACTION_RETENTION_DAYS`        | `365`     | Age after which audit rows may be pruned; at least above |
| `DELIVERY_RETENTION_INTERVAL_MS`               | `3600000` | Time between passes of one worker                        |
| `DELIVERY_RETENTION_BATCH_SIZE`                | `500`     | Maximum rows deleted per statement                       |
| `DELIVERY_RETENTION_MIN_ATTEMPTS_PER_DELIVERY` | `3`       | Newest attempts always kept per delivery (at least 1)    |

Values are validated at startup like the other delivery settings (the API shares the loader, so
an invalid value stops it too, but only the worker ever prunes); the audit retention may not be
shorter than the attempt retention.

## Pagination

Pages use descending keyset pagination over the persisted `paginationAt` and UUID. An
opaque base64url cursor contains that validated tuple, avoiding growing offset cost and page
shifts from newer rows. `paginationAt` never changes after insertion, so completing a
delivery between two page requests cannot make a comment repeat or disappear from a walk.

Cursors carry a version (`v: 2`). Cursors issued before the upgrade have no version and
held `COALESCE(remoteCreatedAt, createdAt)`; the migration backfills `paginationAt` with
exactly that expression, so they address the same position and are accepted unchanged. A cursor
with any other version is rejected as invalid rather than guessed at. A client that is
mid-walk across the upgrade can still see the old anomaly for a reply that was delivered
before it; nothing is made worse.

A page selects its `limit + 1` candidate comments first, with every filter and the cursor
applied and seeking the `paginationAt` indexes, and only then counts replies for those
candidates with one indexed lookup each.

## Errors

Errors use `application/problem+json` with `type`, `title`, `status`, `detail`,
`code`, and `requestId`. Validation errors may include safe field messages, and
provider failures may include `replyId` and `retryable`. NestJS exceptions preserve
their HTTP status with safe text. Stack traces and raw framework, database, or
provider details are never returned.

Every response includes or echoes `X-Request-Id`.

## Testing

Unit tests require no services:

```bash
pnpm test
```

Integration and E2E suites use a disposable `commentbridge_test` database and load
`.env.test.example` (then an optional git-ignored `.env.test.local` for machine-specific
overrides such as a different port). Before any destructive reset, the guard requires
`NODE_ENV=test` and that **every** configured database URL names a database ending in
`_test`; unsafe settings are refused without exposing a connection URL.

The test database is an in-memory container bound to `127.0.0.1`, started from its own
compose file with throwaway credentials that live in `.env.test.example` and protect nothing.
Administrative credentials (`MIGRATION_DATABASE_URL`) are used only to migrate, provision roles,
and set up fixtures; the code under test runs as the restricted `commentbridge_api` and
`commentbridge_worker` roles, so every suite also exercises the privilege boundary.

```bash
pnpm db:test:up            # docker compose -f docker-compose.test.yml ...
pnpm db:test:migrate       # migrate as the owner, then provision the runtime roles
pnpm test:integration
pnpm test:e2e
```

If port 55433 is taken, create `.env.test.local` with a different `POSTGRES_TEST_PORT` and the
three database URLs, and start the database with `POSTGRES_TEST_PORT=<port> pnpm db:test:up`.
Run the database suites sequentially (`--runInBand` is already set); they share one database.

Complete local validation:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
# Compose files need their passwords: from .env, or the environment.
docker compose config --quiet
docker compose -f docker-compose.app.yml config --quiet
pnpm db:test:up
pnpm db:test:migrate
pnpm test:integration
pnpm test:e2e
pnpm build
git diff --check
```

## Assumptions and trade-offs

- Authentication, authorization, OAuth, and real provider credentials are outside
  the assignment scope.
- Posts, accounts, publications, and synchronized inbound comments already exist
  in PostgreSQL as the normalized read model.
- The API returns a bounded flat list rather than recursively expanding threads.
- Mock adapters are deterministic and make no external requests.
- Outbound jobs are polled by a separate worker process (`pnpm start:worker`), never
  by the API. Operational limits are environment variables (see above).
- Parent/publication consistency and delivery-field invariants are enforced by
  PostgreSQL as well as the application workflow.

See [docs/DECISIONS.md](docs/DECISIONS.md) for the engineering decisions.

## Production evolution

The durable delivery state machine, provider lookup reconciliation, delivery status,
conditional manual retry, dead-letter controls, and manual-action audit trail are
implemented. Operator API-key authentication, the standalone worker process, and
PostgreSQL-backed worker heartbeats and delivery history retention are implemented.
Application-level liveness, readiness and operational delivery health with stable alert
codes are implemented; exporting them to a metrics or alerting system is left to the
consumer of those endpoints. Production evolution should add an external identity provider in place of static keys. Inbound sync could add authenticated
webhooks or polling. Tenant authorization, encrypted provider credentials,
throttling, and metrics export should follow concrete operational requirements.

## AI-assisted development

I designed the solution and made the final engineering decisions with AI-assisted
support. Claude was used as a collaborator during the initial architecture and
design phase, GitHub Copilot assisted me with implementation, and Codex assisted
with the code review.

I reviewed, adapted, tested, and validated all submitted code and remain fully
responsible for the implementation and its engineering decisions.
