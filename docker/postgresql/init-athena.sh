#!/bin/sh
set -eu

# Local/CI rehearsal roles mirror the production trust boundaries. Passwords
# may share local values, but the principals, databases and grants stay
# separate so an API credential cannot silently acquire migration privileges.
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set admin_user="$POSTGRES_USER" \
  --set admin_password="$POSTGRES_PASSWORD" \
  --set main_password="$ATHENA_POSTGRES_MAIN_PASSWORD" \
  --set auth_password="$ATHENA_POSTGRES_AUTH_PASSWORD" <<'SQL'
SELECT format('ALTER ROLE %I PASSWORD %L', :'admin_user', :'admin_password')\gexec
SELECT 'CREATE ROLE athena_main_owner NOLOGIN'
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_main_owner')\gexec
SELECT 'CREATE ROLE athena_auth_owner NOLOGIN'
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_auth_owner')\gexec

SELECT format('CREATE ROLE athena_main_migrator LOGIN PASSWORD %L IN ROLE athena_main_owner', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_main_migrator')\gexec
SELECT format('CREATE ROLE athena_main_api LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_main_api')\gexec
SELECT format('CREATE ROLE athena_main_background LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_main_background')\gexec
SELECT format('CREATE ROLE athena_main_reader LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_main_reader')\gexec
SELECT format('CREATE ROLE athena_main_gateway LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_main_gateway')\gexec

SELECT format('CREATE ROLE athena_auth_migrator LOGIN PASSWORD %L IN ROLE athena_auth_owner', :'auth_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_auth_migrator')\gexec
SELECT format('CREATE ROLE athena_auth_api LOGIN PASSWORD %L', :'auth_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_auth_api')\gexec
SELECT format('CREATE ROLE athena_main_observer LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_main_observer')\gexec
SELECT format('CREATE ROLE athena_auth_observer LOGIN PASSWORD %L', :'auth_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_auth_observer')\gexec

ALTER ROLE athena_main_migrator PASSWORD :'main_password';
ALTER ROLE athena_main_api PASSWORD :'main_password';
ALTER ROLE athena_main_background PASSWORD :'main_password';
ALTER ROLE athena_main_reader PASSWORD :'main_password';
ALTER ROLE athena_main_gateway PASSWORD :'main_password';
ALTER ROLE athena_main_observer PASSWORD :'main_password';
ALTER ROLE athena_auth_migrator PASSWORD :'auth_password';
ALTER ROLE athena_auth_api PASSWORD :'auth_password';
ALTER ROLE athena_auth_observer PASSWORD :'auth_password';

SELECT 'CREATE DATABASE athena_main OWNER athena_main_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'athena_main')\gexec
SELECT 'CREATE DATABASE athena_auth OWNER athena_auth_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'athena_auth')\gexec

REVOKE ALL ON DATABASE athena_main FROM PUBLIC;
REVOKE ALL ON DATABASE athena_auth FROM PUBLIC;
GRANT CONNECT ON DATABASE athena_main TO athena_main_migrator, athena_main_api, athena_main_background, athena_main_reader, athena_main_gateway, athena_main_observer;
GRANT CONNECT ON DATABASE athena_auth TO athena_auth_migrator, athena_auth_api, athena_auth_observer;
ALTER ROLE athena_main_migrator IN DATABASE athena_main SET ROLE TO athena_main_owner;
ALTER ROLE athena_auth_migrator IN DATABASE athena_auth SET ROLE TO athena_auth_owner;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname athena_main <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO athena_main_owner;
GRANT USAGE ON SCHEMA public TO athena_main_api, athena_main_background, athena_main_reader, athena_main_gateway, athena_main_observer;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_main_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_main_api, athena_main_background;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_main_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO athena_main_reader, athena_main_gateway;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_main_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO athena_main_observer;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_main_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO athena_main_api, athena_main_background;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname athena_auth <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO athena_auth_owner;
GRANT USAGE ON SCHEMA public TO athena_auth_api, athena_auth_observer;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_auth_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_auth_api;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_auth_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO athena_auth_api;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_auth_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO athena_auth_observer;
SQL

# Create the logical service schemas before any service split is enabled. These
# grants deliberately do not include public or the legacy API roles: a
# micro-module principal can only use its own schema. During expand/contract the
# legacy Prisma schemas remain in public until their ownership migration reaches
# 100% coverage.
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set main_password="$ATHENA_POSTGRES_MAIN_PASSWORD" \
  --set auth_password="$ATHENA_POSTGRES_AUTH_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE athena_identity LOGIN PASSWORD %L', :'auth_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_identity')\gexec
SELECT format('CREATE ROLE athena_key_custody LOGIN PASSWORD %L', :'auth_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_key_custody')\gexec

SELECT format('CREATE ROLE athena_workspace LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_workspace')\gexec
SELECT format('CREATE ROLE athena_chat LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_chat')\gexec
SELECT format('CREATE ROLE athena_agent LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_agent')\gexec
SELECT format('CREATE ROLE athena_model_runtime LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_model_runtime')\gexec
SELECT format('CREATE ROLE athena_tools LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_tools')\gexec
SELECT format('CREATE ROLE athena_crypto_market LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_crypto_market')\gexec
SELECT format('CREATE ROLE athena_crypto_account LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_crypto_account')\gexec
SELECT format('CREATE ROLE athena_crypto_forecast LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_crypto_forecast')\gexec
SELECT format('CREATE ROLE athena_browser_plane LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_browser_plane')\gexec
SELECT format('CREATE ROLE athena_knowledge_query LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_knowledge_query')\gexec
SELECT format('CREATE ROLE athena_knowledge_ingest LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_knowledge_ingest')\gexec
SELECT format('CREATE ROLE athena_knowledge_reader LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_knowledge_reader')\gexec
SELECT format('CREATE ROLE athena_maintenance LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_maintenance')\gexec
SELECT format('CREATE ROLE athena_scheduler LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_scheduler')\gexec
SELECT format('CREATE ROLE athena_sync LOGIN PASSWORD %L', :'main_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'athena_sync')\gexec

ALTER ROLE athena_identity PASSWORD :'auth_password';
ALTER ROLE athena_key_custody PASSWORD :'auth_password';
ALTER ROLE athena_workspace PASSWORD :'main_password';
ALTER ROLE athena_chat PASSWORD :'main_password';
ALTER ROLE athena_agent PASSWORD :'main_password';
ALTER ROLE athena_model_runtime PASSWORD :'main_password';
ALTER ROLE athena_tools PASSWORD :'main_password';
ALTER ROLE athena_crypto_market PASSWORD :'main_password';
ALTER ROLE athena_crypto_account PASSWORD :'main_password';
ALTER ROLE athena_crypto_forecast PASSWORD :'main_password';
ALTER ROLE athena_browser_plane PASSWORD :'main_password';
ALTER ROLE athena_knowledge_query PASSWORD :'main_password';
ALTER ROLE athena_knowledge_ingest PASSWORD :'main_password';
ALTER ROLE athena_knowledge_reader PASSWORD :'main_password';
ALTER ROLE athena_maintenance PASSWORD :'main_password';
ALTER ROLE athena_scheduler PASSWORD :'main_password';
ALTER ROLE athena_sync PASSWORD :'main_password';

GRANT CONNECT ON DATABASE athena_auth TO athena_identity, athena_key_custody;
GRANT CONNECT ON DATABASE athena_main TO athena_identity, athena_key_custody;
GRANT CONNECT ON DATABASE athena_main TO
  athena_workspace,
  athena_chat,
  athena_agent,
  athena_model_runtime,
  athena_tools,
  athena_crypto_market,
  athena_crypto_account,
  athena_crypto_forecast,
  athena_browser_plane,
  athena_knowledge_query,
  athena_knowledge_ingest,
  athena_knowledge_reader,
  athena_maintenance,
  athena_scheduler,
  athena_sync;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname athena_auth <<'SQL'
CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION athena_auth_owner;
CREATE SCHEMA IF NOT EXISTS key_custody AUTHORIZATION athena_auth_owner;

REVOKE ALL ON SCHEMA identity, key_custody FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA identity TO athena_identity;
GRANT USAGE, CREATE ON SCHEMA key_custody TO athena_key_custody;

ALTER DEFAULT PRIVILEGES FOR ROLE athena_identity IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_identity;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_identity IN SCHEMA identity
  GRANT USAGE, SELECT ON SEQUENCES TO athena_identity;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_key_custody IN SCHEMA key_custody
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_key_custody;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_key_custody IN SCHEMA key_custody
  GRANT USAGE, SELECT ON SEQUENCES TO athena_key_custody;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname athena_main <<'SQL'
-- Until the security governance tables are physically moved into the
-- key_custody schema, the dedicated principal owns only their exact legacy
-- public-table ACLs. This keeps expand/contract compatible without restoring
-- the old main API or observer credential inside Key Custody.
GRANT USAGE ON SCHEMA public TO athena_key_custody;
DO $$
DECLARE
  object_name text;
BEGIN
  FOREACH object_name IN ARRAY ARRAY[
    'security_key_registry',
    'security_key_domain_bindings',
    'security_key_rotation_jobs',
    'security_key_rotation_approvals',
    'security_key_events'
  ] LOOP
    IF to_regclass(format('public.%I', object_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO athena_key_custody',
        object_name
      );
    END IF;
    IF to_regclass(format('public.%I_id_seq', object_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE public.%I TO athena_key_custody',
        object_name || '_id_seq'
      );
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS workspace AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS agent AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS model_runtime AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS tools AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS crypto_market AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS crypto_account AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS crypto_forecast AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS browser_plane AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS knowledge_query AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS knowledge_ingest AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS knowledge_reader AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS maintenance AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS scheduler AUTHORIZATION athena_main_owner;
CREATE SCHEMA IF NOT EXISTS sync AUTHORIZATION athena_main_owner;

REVOKE ALL ON SCHEMA
  identity,
  workspace,
  chat,
  agent,
  model_runtime,
  tools,
  crypto_market,
  crypto_account,
  crypto_forecast,
  browser_plane,
  knowledge_query,
  knowledge_ingest,
  knowledge_reader,
  maintenance,
  scheduler,
  sync
FROM PUBLIC;

GRANT USAGE, CREATE ON SCHEMA identity TO athena_identity;
GRANT USAGE, CREATE ON SCHEMA workspace TO athena_workspace;
GRANT USAGE, CREATE ON SCHEMA chat TO athena_chat;
GRANT USAGE, CREATE ON SCHEMA agent TO athena_agent;
GRANT USAGE, CREATE ON SCHEMA model_runtime TO athena_model_runtime;
GRANT USAGE, CREATE ON SCHEMA tools TO athena_tools;
GRANT USAGE, CREATE ON SCHEMA crypto_market TO athena_crypto_market;
GRANT USAGE, CREATE ON SCHEMA crypto_account TO athena_crypto_account;
GRANT USAGE, CREATE ON SCHEMA crypto_forecast TO athena_crypto_forecast;
GRANT USAGE, CREATE ON SCHEMA browser_plane TO athena_browser_plane;
GRANT USAGE, CREATE ON SCHEMA knowledge_query TO athena_knowledge_query;
GRANT USAGE, CREATE ON SCHEMA knowledge_ingest TO athena_knowledge_ingest;
GRANT USAGE, CREATE ON SCHEMA knowledge_reader TO athena_knowledge_reader;
GRANT USAGE, CREATE ON SCHEMA maintenance TO athena_maintenance;
GRANT USAGE, CREATE ON SCHEMA scheduler TO athena_scheduler;
GRANT USAGE, CREATE ON SCHEMA sync TO athena_sync;

ALTER DEFAULT PRIVILEGES FOR ROLE athena_identity IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_identity;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_workspace IN SCHEMA workspace
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_workspace;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_chat IN SCHEMA chat
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_chat;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_agent IN SCHEMA agent
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_agent;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_model_runtime IN SCHEMA model_runtime
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_model_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_tools IN SCHEMA tools
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_tools;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_crypto_market IN SCHEMA crypto_market
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_crypto_market;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_crypto_account IN SCHEMA crypto_account
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_crypto_account;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_crypto_forecast IN SCHEMA crypto_forecast
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_crypto_forecast;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_browser_plane IN SCHEMA browser_plane
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_browser_plane;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_knowledge_query IN SCHEMA knowledge_query
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_knowledge_query;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_knowledge_ingest IN SCHEMA knowledge_ingest
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_knowledge_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_knowledge_reader IN SCHEMA knowledge_reader
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_knowledge_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_maintenance IN SCHEMA maintenance
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_maintenance;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_scheduler IN SCHEMA scheduler
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_scheduler;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_sync IN SCHEMA sync
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_sync;

ALTER DEFAULT PRIVILEGES FOR ROLE athena_identity IN SCHEMA identity
  GRANT USAGE, SELECT ON SEQUENCES TO athena_identity;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_workspace IN SCHEMA workspace
  GRANT USAGE, SELECT ON SEQUENCES TO athena_workspace;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_chat IN SCHEMA chat
  GRANT USAGE, SELECT ON SEQUENCES TO athena_chat;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_agent IN SCHEMA agent
  GRANT USAGE, SELECT ON SEQUENCES TO athena_agent;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_model_runtime IN SCHEMA model_runtime
  GRANT USAGE, SELECT ON SEQUENCES TO athena_model_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_tools IN SCHEMA tools
  GRANT USAGE, SELECT ON SEQUENCES TO athena_tools;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_crypto_market IN SCHEMA crypto_market
  GRANT USAGE, SELECT ON SEQUENCES TO athena_crypto_market;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_crypto_account IN SCHEMA crypto_account
  GRANT USAGE, SELECT ON SEQUENCES TO athena_crypto_account;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_crypto_forecast IN SCHEMA crypto_forecast
  GRANT USAGE, SELECT ON SEQUENCES TO athena_crypto_forecast;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_browser_plane IN SCHEMA browser_plane
  GRANT USAGE, SELECT ON SEQUENCES TO athena_browser_plane;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_knowledge_query IN SCHEMA knowledge_query
  GRANT USAGE, SELECT ON SEQUENCES TO athena_knowledge_query;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_knowledge_ingest IN SCHEMA knowledge_ingest
  GRANT USAGE, SELECT ON SEQUENCES TO athena_knowledge_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_knowledge_reader IN SCHEMA knowledge_reader
  GRANT USAGE, SELECT ON SEQUENCES TO athena_knowledge_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_maintenance IN SCHEMA maintenance
  GRANT USAGE, SELECT ON SEQUENCES TO athena_maintenance;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_scheduler IN SCHEMA scheduler
  GRANT USAGE, SELECT ON SEQUENCES TO athena_scheduler;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_sync IN SCHEMA sync
  GRANT USAGE, SELECT ON SEQUENCES TO athena_sync;
SQL
