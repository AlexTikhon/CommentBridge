# CommentBridge Final Review Plan

## Verified current behavior

- The repository is a strict TypeScript/NestJS application backed by PostgreSQL
  and Prisma, with one logical `Post`, per-account `PostPublication` records, and
  one self-referencing `Comment` table for inbound comments and outbound replies.
- Comment reads use a raw SQL keyset query ordered by
  `COALESCE(remoteCreatedAt, createdAt), id`; optional platform and direct-parent
  filters are implemented.
- Reply creation persists `PENDING`, calls the selected deterministic mock adapter
  outside a database transaction, then persists `SENT` or `FAILED` with only a
  safe provider error code.
- Custom `ApplicationError` instances are returned as RFC 7807-style problem
  details with a request ID. Validation errors preserve class-validator messages.
- The current baseline passes `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
  `pnpm test` (14 tests), and `pnpm build`.
- `.env` and `dist/` exist locally but are ignored and are not tracked. No tracked
  coverage, logs, archives, credentials, or generated build output were found.
- Docker and Docker Compose are available and the existing development PostgreSQL
  service is healthy.
- Integration and E2E tests were inspected but not executed before this plan:
  their unguarded `deleteMany()` setup could reset any database named by
  `DATABASE_URL`.

## Confirmed defects

1. Reply idempotency is scoped to `(postPublicationId, idempotencyKey)` in the
   Prisma schema, migration, repository contract, and lookup. The same key on two
   parent comments in one publication is therefore incorrectly shared.
2. The comment-read SQL does not require `PostPublication.status = PUBLISHED`.
   Its reply-count join also does not constrain a reply to the visible
   publication.
3. The global exception filter handles only custom errors and
   `BadRequestException`; other NestJS `HttpException` values, including unknown
   routes, become 500 responses.
4. `SocialPlatformAdapter` requires `getCallCount` and `resetCallCount`, which are
   test instrumentation rather than provider behavior.
5. Destructive integration/E2E setup has no environment or database-name guard
   and the test scripts load the ordinary `.env` file.
6. The API exposes `publishedAt = remoteCreatedAt ?? createdAt`, which incorrectly
   describes local creation time as remote publication time for pending/failed
   replies.
7. New outbound replies set only the account display name; their normalized
   `authorExternalId` is left null despite the social account external ID being
   available.
8. The service's parent/publication comparison only checks consistency of an
   already-joined record. It is effectively unreachable and misleading; reply
   persistence already correctly derives `postPublicationId` from the loaded
   parent.
9. The ordinary compound comment timestamp indexes duplicate the effective-time
   expression indexes used by the actual raw SQL ordering. The uniqueness and
   expression indexes remain required.
10. Product naming is inconsistent (`Social Comments API` and
    `social-comments-api`), `LOG_LEVEL` is documented but unused, README content
    is repetitive, the AI disclosure is incomplete, and
    `IMPLEMENTATION_PLAN.md` duplicates final documentation.
11. Swagger describes the old publication-scoped key and old timestamp field.
    Existing tests do not cover the required mixed-status, parent-scoped
    idempotency, concurrency, generic HTTP exception, author, timestamp, or
    database-safety cases.

## Exact files to change

- Product/application behavior:
  - `package.json`, `pnpm-lock.yaml`
  - `src/main.ts`
  - `src/comments/application/comments.service.ts`
  - `src/comments/application/ports/comment.repository.ts`
  - `src/comments/domain/comment.errors.ts`
  - `src/comments/infrastructure/prisma-comment.repository.ts`
  - `src/comments/presentation/comments.controller.ts`
  - `src/comments/presentation/dto/comment.response.ts`
  - `src/common/errors/problem-details.filter.ts`
  - `src/platforms/domain/platform.types.ts`
  - `src/platforms/infrastructure/mock-adapter.base.ts`
- Database:
  - `prisma/schema.prisma`
  - a new additive migration under `prisma/migrations/`
- Test safety/configuration:
  - `.env.example`, new `.env.test.example`, `.gitignore`
  - `docker-compose.yml`
  - `test/database-test-utils.ts`
  - `test/jest-integration.json`, `test/jest-e2e.json`
- Tests:
  - `src/comments/application/comments.service.spec.ts`
  - new `src/common/errors/problem-details.filter.spec.ts`
  - new `test/database-test-utils.spec.ts`
  - `test/integration/comments.integration-spec.ts`
  - `test/e2e/comments.e2e-spec.ts`
- Final documentation and cleanup:
  - `README.md`, `docs/DECISIONS.md`
  - remove `IMPLEMENTATION_PLAN.md` after moving any unique useful content
  - retain this requested `FINAL_REVIEW_PLAN.md` as the verified review record

## Tests to add or update

- Unit: use Jest spies instead of adapter counters; assert successful send,
  provider failure, platform limits, unpublished reply rejection, same-parent
  replay/conflict, parent-scoped repository calls, different-parent key reuse,
  derived publication/author values, registry behavior, cursor codec behavior,
  safe mappings for custom errors and representative/generic Nest HTTP
  exceptions, and database-reset guard acceptance/rejection without credentials
  in messages.
- Integration: seed mixed `PUBLISHED`, `DRAFT`, and `FAILED` publications; verify
  visibility, platform/parent filters, reply counts, stable pagination, timestamp
  records, outbound identity, external ID uniqueness, same-parent uniqueness,
  same key on different parents, concurrent duplicate protection and one adapter
  call, success/failure persistence, and safe provider error storage.
- E2E: verify GET comments, mixed-status exclusion, successful reply/replay,
  same key on another parent, message conflict, provider failure, invalid body,
  unknown comment, unknown route 404, invalid UUID/framework validation, request
  IDs, response timestamp semantics, and one provider call on replay.

## Repository-cleanup actions

- Keep ignored local `.env` and `dist/` untracked; do not delete the developer's
  local copies.
- Add `.env.test` to ignore rules while tracking only `.env.test.example`.
- Remove the duplicate `IMPLEMENTATION_PLAN.md` and references to it.
- Remove unused `LOG_LEVEL` documentation instead of adding unnecessary logging
  configuration.
- Rename user-facing/package metadata to CommentBridge and rewrite README in the
  requested reviewer-oriented order, including the exact AI-assisted development
  disclosure and safe `git archive` command.
- Re-run tracked-file, secret, private-name, generated-output, status, and
  whitespace checks before declaring readiness.

## Validation plan

1. Run `pnpm install`, formatting, lint, typecheck, unit, integration, E2E, and
   build commands and report their exact outcomes.
2. Add a dedicated disposable `commentbridge_test` PostgreSQL Compose service.
   Require both `NODE_ENV=test` and a database name ending in `_test` before any
   destructive test setup. Run the guard's unit tests before database suites.
3. Apply all migrations to the clean test database and run the seed. The additive
   migration will validate existing outbound parents before replacing
   publication-scoped idempotency with `(parentId, idempotencyKey)` and dropping
   only confirmed-redundant regular timestamp indexes.
4. Exercise upgrade migration behavior from the existing initial migration where
   practical, then verify the final schema/indexes and regenerate Prisma Client.
5. Run `docker compose config` and `git diff --check`.
6. Start CommentBridge using the repository's actual port/configuration and verify
   `GET /health`, comment retrieval, reply creation, Swagger UI, and OpenAPI JSON.
7. Confirm no `.env`, build/test output, archives, credentials, private data, or
   database volumes are tracked; confirm seed data and Compose credentials are
   synthetic/local-only.
8. Do not commit or create the submission archive automatically.
