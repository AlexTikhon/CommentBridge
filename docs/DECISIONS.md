# CommentBridge Engineering Decisions

## Logical post and publication

`Post` represents authored content once. `PostPublication` represents delivery to
one social account and owns the provider post ID, status, and publication time.
This keeps platform delivery state out of the logical content model and supports
one post across several platforms.

Comment reads join publications and explicitly require `PUBLISHED`. Platform and
parent filters, pagination, and reply counts operate inside that visibility rule.

## One normalized comment table

Inbound comments and outbound replies share identity, text, authorship, timing,
and delivery metadata. One self-referencing table therefore provides a consistent
read model. Direction and delivery status make lifecycle differences explicit,
with SQL checks rejecting invalid direction/status combinations and outbound rows
without a parent.

`createdAt` is local persistence time. `remoteCreatedAt` is the optional provider
timestamp. The API exposes both instead of describing the local fallback as a
remote publication time.

## Parent/publication invariant

Reply creation loads the parent with its publication and derives the child's
`postPublicationId` directly from that record. PostgreSQL independently enforces
the same rule through a composite foreign key from
`(parentId, postPublicationId)` to `(id, postPublicationId)`. Root comments remain
valid because nullable `parentId` bypasses the self-reference, while no writer can
link a reply to a parent from another publication.

Migration preflight checks fail before changing constraints if historical rows
violate the relationship. Additional validated checks require external identity
for inbound comments, coherent provider fields for each outbound lifecycle state,
and agreement between publication status and `publishedAt`.

## Parent-scoped idempotency

Reply idempotency is unique on `(parentId, idempotencyKey)`, and repository lookups
use the same pair. Identical same-parent requests replay the stored result without
a provider call; a changed message conflicts; another parent can reuse the key.
The database constraint protects concurrent creation races.

The upgrade migration first validates that existing outbound rows have parents,
creates the new unique index, and only then drops publication-scoped uniqueness.
It rewrites no existing data and fails safely if pre-existing rows violate the
required parent rule.

## Cursor pagination and indexes

Keyset pagination orders by `COALESCE(remoteCreatedAt, createdAt)` and UUID. SQL
expression indexes match the publication and parent query shapes; they remain in
the migration because Prisma cannot represent expression indexes. Ordinary
compound indexes over the separate timestamp columns were removed because they
did not match the executed ordering expression. Required external-ID and
idempotency uniqueness indexes remain.

## Platform adapters

The service resolves one capability-aware `SocialPlatformAdapter` through a
registry. The port contains platform identity, capabilities, and reply behavior
only. Jest spies observe calls in tests, so future real adapters are not required
to implement counters or reset hooks.

## Outbound delivery lifecycle

Reply creation atomically inserts the normalized `PENDING` comment and its
one-to-one `ReplyDelivery` job. The API returns `202` without calling a provider.
Workers claim due jobs through `FOR UPDATE SKIP LOCKED`, increment the attempt
number, and acquire a finite lease, so concurrent workers cannot deliver the same
attempt.

Each provider call has a durable `ReplyDeliveryAttempt`. Explicitly retryable
adapter errors schedule bounded exponential backoff and reuse the original
idempotency key. Terminal errors move both job and comment to `FAILED`. Unknown
exceptions and timeouts become `UNKNOWN` because provider acceptance may be
ambiguous.

Provider calls and success persistence remain separate error boundaries. If the
provider succeeds but the success transaction fails, the job stays `PROCESSING`.
After its lease expires, reconciliation moves the job and open attempt to `UNKNOWN`
instead of retrying blindly; the public comment remains `PENDING`. The worker leases
UNKNOWN jobs without creating another delivery attempt and performs provider lookup
using the original idempotency context. A found reply completes the original attempt;
only authoritative absence schedules a bounded retry. Lookup errors remain UNKNOWN
with backoff, so an inconclusive reconciliation never causes duplicate delivery.

The operational API exposes current delivery state and at most the 20 most recent
attempts. Manual retry is a database-conditional `FAILED` to `RETRY` transition in
the same transaction that changes the public comment from `FAILED` to `PENDING`.
The attempt counter and history remain monotonic. Competing retry requests cannot
both succeed, and `UNKNOWN` is deliberately excluded so operators cannot bypass
provider reconciliation.

Dead-lettering has its own terminal `DEAD_LETTERED` job state rather than overloading
provider failure. It is allowed from `PENDING`, `RETRY`, `FAILED`, and `UNKNOWN`, and
is blocked while a worker owns `PROCESSING` or after `SUCCEEDED`. Every successful
manual retry or dead-letter transition inserts an immutable action row containing
operator ID, normalized reason, previous state, resulting state, and timestamp in
the same database transaction. The operator is the authenticated principal
described under Operator authentication below.

## Lease ownership tokens

A lease timestamp cannot prove who owns a delivery. A worker that stalls past its
lease is reconciled to `UNKNOWN`, and the lookup claim that follows reuses the
same attempt number, so a guard of `status = PROCESSING` plus attempt number would
accept the stalled worker's late write against the new owner's lease. Each claim
therefore receives a unique `leaseToken` generated in PostgreSQL, and every
worker-owned transition is a conditional update on that exact token. A mismatch
changes nothing and raises an internal `DeliveryLeaseLostError`; the winner (or
provider lookup) decides the outcome. A database check ties `leaseUntil` and
`leaseToken` to `PROCESSING`.

Expired-lease reconciliation is a single statement rather than a read followed by
a write, so a delivery that completes or is re-leased in between is never
misclassified and the returned count is exact. The migration assigns tokens to any
in-flight `PROCESSING` rows without touching their status or expiry; they can only
end by expiring into `UNKNOWN`.

Scheduling reserves a bounded share of each drain for `UNKNOWN` reconciliation
rather than strict priority, trading a little reconciliation latency for the
guarantee that fresh replies are never starved. Completion timestamps come from the
worker's clock, not from hidden `new Date()` calls in the repository.

## Worker observability

Queue depth and lag are read from PostgreSQL in a single statement because the
queue is the durable source of truth shared by every instance. Lag counts only work
that is already due, so scheduled retries do not look like backlog. Per-process
counters remain inside the worker for logging and tests, avoiding a metrics
dependency until a concrete scraper exists, but they are not an operational view:
see _Persistent worker runtime state_ below. Each job reports a closed set of
outcomes, including `LEASE_LOST`, so a stale write is visible instead of only logged.

## Separate worker runtime

HTTP request serving and asynchronous delivery have different lifecycle and scaling
characteristics: the API scales with traffic and must stay responsive, while the
worker scales with provider latency, holds leases, and needs a graceful drain on
shutdown. Running the worker inside the API also meant every API replica polled the
queue by default. The worker is therefore its own process (a Nest application
context with no HTTP listener) built from a module that loads only the database,
adapters, delivery repositories, and the runtime that polls. The API module does not
contain the worker at all, so no shared environment can start a duplicate loop;
`DELIVERY_WORKER_ENABLED` was removed instead of kept as a second switch whose
meaning depends on which process reads it, and it now only produces a startup
warning. Both processes use the same image with different commands. Delivery
semantics (leases, `SKIP LOCKED`, reconciliation) are unchanged; this is a runtime
change only.

## Persistent worker runtime state

Once the worker is a separate process, in-memory metrics in the API cannot describe
it, and a stats endpoint reading them would report misleading zeros. Shared state
lives in PostgreSQL, which both processes already depend on, rather than a new
service: one `DeliveryWorkerInstance` row per worker process lifetime, so several
workers never contend on a row and horizontal scaling needs no redesign. Liveness is
the heartbeat age alone, because a crashed process cannot write a `STOPPED` state;
graceful shutdown just ages out. The heartbeat runs on its own timer (default 10s)
so a slow provider call is not mistaken for a dead worker, and a drain is written
only when it did work, so an idle worker costs one small write per interval rather
than one per poll. The worker instance ID identifies a process and is unrelated to a
delivery's lease token, which guards ownership of one delivery. Cleanup is a single
prune of rows past a 24-hour window when a worker starts: the table grows only with
restarts, so a retention job would be disproportionate until delivery history gets
one. (Delivery history has since gained one, below; this prune stays separate
because it is a single statement at startup and the two tables have unrelated policies.)
Timestamps use each process clock, so host clock skew must stay well below the
stale threshold; using the database clock for staleness is the upgrade if that
becomes a problem.

## Delivery history retention

The three delivery tables answer different questions, so they get different lifetimes.
`ReplyDelivery` is **current domain state**: one row per reply, holding status, the
authoritative attempt counter and the last error. `GET /api/v1/replies/:id/delivery`
returns 404 without it, retry and dead-letter are decided from it, and it carries no
history that outlives the reply, so it is retained for as long as the reply exists.
Nothing in this system deletes replies, so retention never deletes deliveries and does
not invent a parent-deletion mechanism. `ReplyDeliveryAttempt` is **operational
execution history**: useful for diagnosing recent behavior, worthless after a few months,
and growing with every retry, so it is pruned (90 days). `ReplyDeliveryManualAction` is
**operator audit history**: written once, small, and what answers "who changed this and
why", so it is kept longer (365 days) and startup refuses a configuration that expires
it before the attempts.

Eligibility is decided inside the deleting SQL statement, never by selecting ids and
deleting them later. A delivery must be settled (`SUCCEEDED`, `FAILED`, `DEAD_LETTERED`);
`UNKNOWN` is not settled, because reconciliation rewrites the attempt numbered
`attemptCount` and would fail if it were gone. `FAILED` is settled for workers but an
operator may retry it, so the newest N attempts (default 3) always remain; a retry only
appends attempt `attemptCount + 1`. The attempt counter lives on the delivery and is
incremented at claim time, so deleting rows cannot cause an attempt number to be reused.
Batches select with `FOR UPDATE … SKIP LOCKED` on the attempt and `FOR SHARE … SKIP LOCKED`
on its delivery: concurrent runners split the work instead of waiting, the delivery's
state is re-checked under the lock, and a delivery an operator or worker is changing is
skipped. Each statement deletes at most one batch (500) and a pass is capped at 100
batches per table. The cap also bounds shutdown latency, since a stop request is checked
between batches.

Retention runs from the worker process on its own timer, not per poll, and is safe with
several workers because duplicate passes only find fewer rows. Visibility was first
structured logs only; once health had to answer "when did retention last succeed, and is
it overdue" that was no longer enough, and the latest outcome per worker now also lives on
the worker's own `DeliveryWorkerInstance` row (see _Health_ below). It is the latest
outcome, not a history table. Dry-run was left out: a mode that deletes nothing cannot drain a backlog the way
a real pass does, so it would need separate counting SQL that could drift from the
deleting SQL.

Measured, not assumed: against 500,000 deliveries and 700,000 attempts, one statement
took roughly one second whether or not the table had an index on `finishedAt` (950 ms
versus 1,357 ms with work available, 1,095 ms versus 1,202 ms with none), because cost
is dominated by re-checking old attempts that are kept by design. An index was therefore
not added. The steady-state cost grows with the number of settled deliveries, which is
acceptable for an hourly job until tens of millions of deliveries; the next step then is
a high-water mark or time partitioning, not an index. That cost is retention's alone: the
health queries below were written not to repeat it (they never touch settled history), so
the table-growth risk is not multiplied by a monitor polling every few seconds.

## Liveness vs readiness vs operational health

These are three questions with three consumers, and answering them with one endpoint is
how an infrastructure blip becomes an outage.

- **Liveness** (`/health/live`) asks whether restarting this process would help. It checks
  nothing outside the process. If it failed on a database outage, the orchestrator would
  restart every healthy API instance during exactly the moment restarts can't help, and
  the pool reconnects would then land on a database that is trying to recover.
- **Readiness** (`/health/ready`) asks whether this instance should receive traffic. The
  API cannot serve without PostgreSQL, so it runs `SELECT 1`, bounded to 2 seconds so a
  hung pool reads as "not ready" instead of a probe timeout. It deliberately runs no queue
  statistics: probes fire every few seconds on every instance. The pre-existing `/health`
  was already this check (same query, `503` on failure, used by the Compose healthcheck),
  so it keeps its body and status codes untouched instead of being redefined.
- **Operational health** (`/api/v1/deliveries/health`) asks whether asynchronous delivery
  is working. A queue backlog or a stopped worker must never control process liveness or
  readiness: restarting the API does nothing for a backlog, and removing a ready API from
  rotation because workers are down would turn a delivery incident into a read-API
  outage. It is therefore a separate, authenticated operator endpoint that answers `200`
  with the state in the body (including `CRITICAL`), and uses non-2xx only when health
  could not be evaluated; a failed database read is reported as such and never as an
  empty (healthy-looking) result.

Choices inside operational health:

- Worst-signal aggregation with explicit thresholds, no score, so every state can be
  explained by listing the conditions that produced it. Severity is a field beside a
  single stable code per condition (`QUEUE_LAG` with `DEGRADED` or `CRITICAL`) rather than
  a code per severity, so an alert rule matches the condition and routes on severity.
- No-worker is `DEGRADED` during a grace period and `CRITICAL` after it, measured from
  when the last worker went stale or from the API's own start, whichever is later. Stale
  worker rows by themselves are informational: crash and clean shutdown look the same and
  each deploy leaves one for 24 hours, so counting them would make every deploy an
  incident, while real capacity loss with no worker is already `CRITICAL`.
- UNKNOWN age is measured from the start of the attempt that produced the ambiguity, not
  `updatedAt`, because reconciliation rewrites `updatedAt` on every try and would make a
  permanently stuck delivery look recent. Counts are context only; age is the signal.
- Queue lag counts only due `PENDING`/`RETRY` work, so scheduled backoff is not "late".
- The queries are `min(nextAttemptAt)` on the existing `(status, nextAttemptAt, id)`
  index and a count over the (normally tiny) `UNKNOWN` set, plus aggregates over the small
  worker table. They do not reuse the stats statement, which groups the whole delivery
  table, and they add no index.
- Retention outcomes are stored per worker on its own row, so nothing is shared or
  contended, and combined at read time (newest success, newest failure). The only schema
  change is nullable/defaulted columns on `DeliveryWorkerInstance`. Error codes are error
  class names only.
- Lease-loss rate is not a signal: the data exists only as per-process counters and each
  worker's last drain, and a real rate needs an event store. It stays a logged metric.
- Evaluation takes an explicit `now` and is a pure function over plain facts, so every
  boundary is unit-tested with a fixed clock. Thresholds are inclusive.
- Status-transition logging is process-local and only advances on polls; it is a log aid,
  not durable alert deduplication.

## Vendor-neutral alert signals

CommentBridge exposes machine-readable state and stable issue codes; it does not send
Slack messages, emails, or pages. Notification destinations, escalation policies,
deduplication, maintenance windows, and on-call routing change independently of the
application and differ per team, and embedding any one vendor would put its client, its
secrets, and its outage modes inside the delivery path. An application that can be polled
is monitored by whatever the operator already runs (Prometheus blackbox/JSON exporters,
a cloud monitor, a cron plus `curl`) without a code change, and a later metrics or
OpenTelemetry integration can be built on the same evaluator. The endpoint requires an
operator key because queue ages and worker state are operational detail, so a monitor
holds that key as a secret rather than exposing the endpoint publicly.

## Operator authentication

The operations endpoints can change delivery state and expose queue internals, so
they require a bearer API key. A static, environment-configured key list is the
smallest mechanism that gives a verified identity for the audit trail without
choosing an identity provider or a user model. The operator ID is derived from the
matched key, never from a request header, so a caller cannot attribute an action to
someone else. Keys are stored as SHA-256 digests and checked against every
credential with a constant-time comparison; all failures return one indistinguishable 401. The guard fails closed when no keys are configured. Keys are long random
secrets rather than passwords, so a fast digest (not a password hash) is
appropriate. Roles, scopes, per-key expiry, and rotation tooling are intentionally
out of scope and would come with an external identity provider.

## Error boundary and request IDs

Custom application errors retain explicit RFC 7807-style mappings. General NestJS
`HttpException` instances preserve their status but receive generic safe messages;
class-validator details are retained where useful. Unexpected exceptions become a
safe 500. Responses never include stack traces or raw framework, database, or
provider details, and every problem includes a correlation ID.

## Test database safety

Integration and E2E suites target a dedicated Compose database named
`commentbridge_test`. Destructive setup checks `NODE_ENV=test` and the `_test`
database suffix before issuing any delete. Both conditions are required, and the
failure message does not echo the connection URL. The test container uses a
disposable in-memory filesystem to keep this protection simple and local.
