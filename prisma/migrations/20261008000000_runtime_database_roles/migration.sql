-- Restricted runtime roles.
--
-- The API and the delivery worker connect as commentbridge_api and
-- commentbridge_worker. Neither owns anything, neither can run DDL, create or alter
-- roles, or leave its table privileges; the schema owner (the role that runs this
-- migration) stays the only identity that can change the schema.
--
-- The roles are created NOLOGIN. A migration cannot carry a password, so the login
-- and its externally supplied password are applied afterwards by
-- `pnpm db:provision-roles` (see prisma/provision-roles.ts). A role that a DBA
-- created beforehand is reused, and its attributes are normalised below.
--
-- Every table must be decided here. The privilege matrix is duplicated in
-- test/integration/database-roles.integration-spec.ts, which fails if a table is
-- added without a decision, so a later migration cannot leave one ungoverned.

DO $$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['commentbridge_api', 'commentbridge_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', runtime_role);
    END IF;

    EXECUTE format(
      'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      runtime_role
    );

    -- Ceilings for any session of these roles, including a client that applies no
    -- budgets of its own (an operator running psql with the worker's credentials).
    -- The application sets tighter values on its own connections.
    EXECUTE format('ALTER ROLE %I SET statement_timeout = ''30s''', runtime_role);
    EXECUTE format('ALTER ROLE %I SET lock_timeout = ''10s''', runtime_role);
    EXECUTE format(
      'ALTER ROLE %I SET idle_in_transaction_session_timeout = ''60s''',
      runtime_role
    );

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), runtime_role);
  END LOOP;

  -- No creating anything: not tables in the public schema, not temporary tables.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO commentbridge_api, commentbridge_worker;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM commentbridge_api, commentbridge_worker;

-- API: serves reads, queues replies, and applies operator retry / dead-letter.
-- It never deletes, and never touches attempts or worker rows except to read them.
GRANT SELECT ON "SocialAccount", "Post", "PostPublication" TO commentbridge_api;
GRANT SELECT, INSERT, UPDATE ON "Comment", "ReplyDelivery" TO commentbridge_api;
GRANT SELECT ON "ReplyDeliveryAttempt", "DeliveryWorkerInstance" TO commentbridge_api;
GRANT SELECT, INSERT ON "ReplyDeliveryManualAction" TO commentbridge_api;

-- Worker: claims and completes deliveries, records attempts and its own heartbeat,
-- and prunes delivery history. It cannot create comments or deliveries.
GRANT SELECT ON "SocialAccount", "Post", "PostPublication" TO commentbridge_worker;
GRANT SELECT, UPDATE ON "Comment", "ReplyDelivery" TO commentbridge_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ReplyDeliveryAttempt" TO commentbridge_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON "DeliveryWorkerInstance" TO commentbridge_worker;
-- UPDATE is needed only because the retention query takes FOR UPDATE row locks, which
-- PostgreSQL authorises as UPDATE. The trigger below rejects every actual write.
GRANT SELECT, UPDATE, DELETE ON "ReplyDeliveryManualAction" TO commentbridge_worker;

-- Operator audit rows are written once and never changed.
CREATE FUNCTION "reject_manual_action_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ReplyDeliveryManualAction rows are immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

CREATE TRIGGER "ReplyDeliveryManualAction_immutable"
  BEFORE UPDATE ON "ReplyDeliveryManualAction"
  FOR EACH ROW EXECUTE FUNCTION "reject_manual_action_update"();
