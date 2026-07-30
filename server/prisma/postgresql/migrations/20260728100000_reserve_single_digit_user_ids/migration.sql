-- Preserve existing user identifiers, but reserve 1-9 so every newly created
-- shared-auth or environment shadow user starts at 10 or above.
SELECT setval(
  pg_get_serial_sequence('"users"', 'id'),
  GREATEST(COALESCE((SELECT MAX("id") FROM "users"), 0), 9),
  true
);
