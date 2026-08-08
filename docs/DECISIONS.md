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
instead of retrying blindly; the public comment remains `PENDING`. Provider-specific
reconciliation can later resolve that quarantine to `SENT` or a safe retry.

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
