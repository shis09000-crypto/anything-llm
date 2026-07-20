# Security audit durability incident runbook

1. Set the affected instance not-ready if the audit chain is invalid or archive delivery has failed three consecutive times.
2. Preserve the local audit spool, database, checkpoint and object key; do not truncate or rewrite them.
3. Verify the Ed25519 checkpoint and hash chain with `yarn security:audit`.
4. Check S3 Object Lock mode and retention date, then check SIEM delivery acknowledgements using the archive object key and payload digest.
5. Repair connectivity or credentials without rotating unrelated keys. The maintenance loop safely retries the same immutable object and SIEM notice.
6. Escalate any signature, previous-hash or sequence mismatch as a security incident. Do not auto-heal ledger content.

Production requires COMPLIANCE Object Lock and an HTTPS SIEM sink. Local storage is acceptable for development only and is not WORM evidence.
