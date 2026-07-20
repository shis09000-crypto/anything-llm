# NATS JetStream production security runbook

- Use only `tls://` endpoints and require server certificate validation.
- Give API, Gateway and Push workers separate NATS accounts or scoped users.
- Prefer operator-issued credentials files; never use a shared username/password in production.
- Restrict publish/subscribe subjects to `athena.<environment>.>` for the workload role.
- Mount credentials and private keys read-only with mode `0400` or `0600`.
- Rotate identities through the NATS operator and drain the old durable consumer before revocation.
- Alert on connection health, consumer lag, redelivery rate and authorization violations.
- Athena must report not-ready when the selected NATS transport cannot authenticate or establish mTLS.

The repository configuration is a contract, not proof that a production NATS account or certificate has been provisioned.
