# Engineering Decisions

## Logical `Post` versus `PostPublication`

A post represents authored content once; a publication represents delivery to a
particular social account. Provider post IDs, status, and publication time belong
to the latter. This prevents platform fields from contaminating scheduling logic
and supports one post on several platforms.

## Normalized comments table

Inbound comments and outbound replies share identity, text, authorship, timing,
and delivery metadata, so one table gives a consistent read model. Direction and
delivery status make lifecycle differences explicit, with a PostgreSQL check
constraint rejecting invalid combinations.

## Self-referencing replies

`parentId` models direct reply relationships without a separate reply table. API
queries remain flat and bounded. The application enforces that parent and child
use the same publication because Prisma cannot express that cross-row invariant.

## Adapters for social platforms

The comment service depends on one capability-aware adapter contract and resolves
it through a registry. Platform request shapes, limits, failure mapping, and SDKs
remain outside the core workflow. Adding a platform is enum/configuration,
implementation, and registration work rather than a service conditional.

## Cursor versus offset pagination

Keyset pagination over effective creation time plus UUID gives deterministic order,
avoids growing offset cost, and is less susceptible to shifts caused by new rows.
The encoded cursor is intentionally opaque and validated at the boundary.

## Synchronous partial implementation versus outbox/worker

The take-home commits `PENDING`, calls the adapter synchronously without an open
transaction, and stores `SENT` or `FAILED`. It is compact and observable but has an
ambiguous crash window. Production should atomically write an outbox event and use
a retrying worker plus reconciliation; implementing that here would add machinery
without demonstrating more of the requested design.

## Idempotency

Keys are unique within a publication. A replay with the same normalized message
returns the existing result; a different message conflicts. The database unique
index closes concurrent creation races. This is local at-most-one provider call in
the normal running process, not a distributed exactly-once guarantee.

## Local database as normalized read model

Comment reads do not fan out to providers. Webhooks or polling are assumed to have
synchronized external comments into PostgreSQL. This produces predictable latency,
cross-platform filtering, stable pagination, and a consistent public contract while
allowing provider ingestion to evolve independently.
