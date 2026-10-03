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
that is already due, so scheduled retries do not look like backlog. Worker counters
stay in process memory: they describe one instance, reset on restart, and avoid a
metrics dependency until a concrete scraper exists. The same snapshot and counter
objects can be adapted to Prometheus or OpenTelemetry later without touching the
worker. Each job reports a closed set of outcomes, including `LEASE_LOST`, so a
stale write is visible instead of only logged.

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
