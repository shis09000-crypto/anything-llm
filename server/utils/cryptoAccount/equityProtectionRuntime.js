const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { accountCryptoHubRegistry } = require("./accountHub");
const { resolveApprovedConnection } = require("./connectionService");

const CryptoData = lazyDataAccessFacade("crypto");
const RECONCILE_INTERVAL_MS = 60_000;

class AccountEquityProtectionRuntime {
  constructor({
    registry = accountCryptoHubRegistry,
    listConnections = () =>
      CryptoData.listAccountConnections({
        where: {
          provider: "gate",
          status: "active",
          readOnly: true,
          revokedAt: null,
        },
      }),
    resolveConnection = resolveApprovedConnection,
    reconcileIntervalMs = RECONCILE_INTERVAL_MS,
  } = {}) {
    this.registry = registry;
    this.listConnections = listConnections;
    this.resolveConnection = resolveConnection;
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.timer = null;
    this.running = false;
    this.reconciling = null;
    this.lastReconciledAt = null;
    this.lastError = null;
    this.failedConnections = 0;
  }

  emit(eventType, outcome, severity = "info") {
    emitSemanticEvent({
      eventType,
      category: "crypto-account-equity",
      severity,
      outcome,
      subject: {
        type: "component",
        component: "crypto-account-access",
        operation: "equity-protection-runtime",
      },
      metadata: {
        taskPriority: "P2",
        protected: true,
        sampleIntervalMs: 1_500,
      },
      sensitivity: "metadata_only",
    });
  }

  async reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      try {
        const connections = await this.listConnections();
        const activeIds = new Set(connections.map((row) => String(row.id)));
        let failed = 0;
        for (const connection of connections) {
          try {
            const resolved = await this.resolveConnection({
              user: {
                id: connection.userId,
                authUserId: connection.authUserId,
              },
              expectedCredentialVersion: connection.credentialVersion,
              expectedRootKeyId: connection.rootKeyId,
              expectedDomainKeyVersion: connection.domainKeyVersion,
            });
            const hub = this.registry.get(resolved);
            await hub.equityProtection.start();
          } catch {
            failed += 1;
          }
        }
        for (const hub of this.registry.hubs.values()) {
          if (!activeIds.has(String(hub.connectionId)))
            this.registry.invalidateConnection(hub.connectionId);
        }
        this.failedConnections = failed;
        this.lastReconciledAt = Date.now();
        this.lastError = failed ? "connection_reconcile_partial" : null;
        return this.status();
      } catch (error) {
        this.lastError = error?.code || error?.message || "reconcile_failed";
        this.emit(
          "crypto.account.equity_recording.reconcile_failed",
          "failed",
          "warning"
        );
        return this.status();
      } finally {
        this.reconciling = null;
      }
    })();
    return this.reconciling;
  }

  async start() {
    if (this.running) return this.status();
    this.running = true;
    await this.reconcile();
    this.timer = setInterval(
      () => void this.reconcile(),
      this.reconcileIntervalMs
    );
    this.timer.unref?.();
    this.emit("crypto.account.equity_recording.runtime_started", "started");
    return this.status();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.reconciling?.catch?.(() => {});
    await this.registry.stopProtectedRecorders();
    return this.status();
  }

  status() {
    return {
      running: this.running,
      protected: true,
      priority: "P2",
      policy: "background_continuation",
      sampleIntervalMs: 1_500,
      reconcileIntervalMs: this.reconcileIntervalMs,
      activeRecorders: this.registry.protectedCount(),
      registeredHubs: this.registry.size(),
      failedConnections: this.failedConnections,
      lastReconciledAt: this.lastReconciledAt,
      lastError: this.lastError,
    };
  }
}

const accountEquityProtectionRuntime = new AccountEquityProtectionRuntime();

module.exports = {
  AccountEquityProtectionRuntime,
  RECONCILE_INTERVAL_MS,
  accountEquityProtectionRuntime,
};
