-- Preserve existing user identifiers, but reserve 1-9 so every newly created
-- shared-auth or environment shadow user starts at 10 or above.
UPDATE sqlite_sequence
SET seq = 9
WHERE name = 'users' AND seq < 9;

INSERT INTO sqlite_sequence(name, seq)
SELECT 'users', 9
WHERE NOT EXISTS (
  SELECT 1
  FROM sqlite_sequence
  WHERE name = 'users'
);
