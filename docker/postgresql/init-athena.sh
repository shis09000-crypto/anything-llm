#!/bin/sh
set -eu

# Local/CI rehearsal roles mirror the production trust boundaries. Passwords
# may share local values, but the principals, databases and grants stay
# separate so an API credential cannot silently acquire migration privileges.
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set main_password="$ATHENA_POSTGRES_MAIN_PASSWORD" \
  --set auth_password="$ATHENA_POSTGRES_AUTH_PASSWORD" <<'SQL'
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

SELECT 'CREATE DATABASE athena_main OWNER athena_main_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'athena_main')\gexec
SELECT 'CREATE DATABASE athena_auth OWNER athena_auth_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'athena_auth')\gexec

REVOKE ALL ON DATABASE athena_main FROM PUBLIC;
REVOKE ALL ON DATABASE athena_auth FROM PUBLIC;
GRANT CONNECT ON DATABASE athena_main TO athena_main_migrator, athena_main_api, athena_main_background, athena_main_reader, athena_main_gateway;
GRANT CONNECT ON DATABASE athena_auth TO athena_auth_migrator, athena_auth_api;
ALTER ROLE athena_main_migrator IN DATABASE athena_main SET ROLE TO athena_main_owner;
ALTER ROLE athena_auth_migrator IN DATABASE athena_auth SET ROLE TO athena_auth_owner;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname athena_main <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO athena_main_owner;
GRANT USAGE ON SCHEMA public TO athena_main_api, athena_main_background, athena_main_reader, athena_main_gateway;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_main_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_main_api, athena_main_background;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_main_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO athena_main_reader, athena_main_gateway;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_main_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO athena_main_api, athena_main_background;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname athena_auth <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO athena_auth_owner;
GRANT USAGE ON SCHEMA public TO athena_auth_api;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_auth_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athena_auth_api;
ALTER DEFAULT PRIVILEGES FOR ROLE athena_auth_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO athena_auth_api;
SQL
