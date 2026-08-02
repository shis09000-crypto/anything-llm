const { CryptoRuntime } = require("../modules/crypto");
const prisma = require("../utils/prisma");
const authPrisma = require("../utils/authPrisma");

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    return {
      ...fallback,
      error: error?.message || String(error),
      code: error?.code || null,
    };
  }
}

const CryptoRepository = {
  dataDomain: "crypto",
  repositoryName: "CryptoRepository",

  configStatus() {
    return safeCall(() => CryptoRuntime.config.status(), {
      enabled: false,
      hasApiKey: false,
      hasApiSecret: false,
    });
  },

  hubStatus() {
    return safeCall(() => CryptoRuntime.hub.status(), {
      status: "unavailable",
      connectionStatus: "disconnected",
    });
  },

  loadingProgress() {
    return safeCall(() => CryptoRuntime.hub.loadingProgress(), {
      status: "unavailable",
      progress: 0,
    });
  },

  recentEvents({ limit = 100 } = {}) {
    return CryptoRuntime.gate.recentEvents({ limit });
  },

  snapshot() {
    return {
      config: this.configStatus(),
      hub: this.hubStatus(),
      loading: this.loadingProgress(),
      recentEvents: this.recentEvents({ limit: 25 }),
    };
  },

  activeUserRoot({ authUserId }) {
    return authPrisma.user_root_key_epochs.findFirst({
      where: { authUserId: Number(authUserId), status: "active" },
      orderBy: { rootEpoch: "desc" },
    });
  },

  findAccountConnection({ where, orderBy = undefined, select = undefined }) {
    return prisma.crypto_account_connections.findFirst({
      where,
      ...(orderBy ? { orderBy } : {}),
      ...(select ? { select } : {}),
    });
  },

  uniqueAccountConnection({ where, select = undefined }) {
    return prisma.crypto_account_connections.findUnique({
      where,
      ...(select ? { select } : {}),
    });
  },

  upsertAccountConnection({ where, create, update }) {
    return prisma.crypto_account_connections.upsert({
      where,
      create,
      update,
    });
  },

  listAccountConnections({ where, select = undefined, take = undefined }) {
    return prisma.crypto_account_connections.findMany({
      where,
      ...(select ? { select } : {}),
      ...(take ? { take } : {}),
    });
  },

  updateAccountConnection({ where, data }) {
    return prisma.crypto_account_connections.update({ where, data });
  },

  updateAccountConnections({ where, data }) {
    return prisma.crypto_account_connections.updateMany({ where, data });
  },

  listAccountEquitySnapshots({ where, orderBy = undefined, take = undefined }) {
    return prisma.crypto_account_equity_snapshots.findMany({
      where,
      ...(orderBy ? { orderBy } : {}),
      ...(take ? { take } : {}),
    });
  },

  upsertAccountEquitySnapshot({ where, create, update }) {
    return prisma.crypto_account_equity_snapshots.upsert({
      where,
      create,
      update,
    });
  },

  findUserDomainWrap({ where, orderBy = undefined }) {
    return prisma.user_domain_key_wraps.findFirst({
      where,
      ...(orderBy ? { orderBy } : {}),
    });
  },
};

module.exports = { CryptoRepository };
