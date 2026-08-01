const crypto = require("crypto");
const authPrisma = require("../utils/authPrisma");

const MEMORY_MAX_ENTRIES = 10_000;
const memoryTickets = new Map();

function storeName(env = process.env) {
  const configured = String(env.ATHENA_REALTIME_TICKET_STORE || "")
    .trim()
    .toLowerCase();
  if (configured) return configured;
  return env.NODE_ENV === "production" ? "database" : "memory";
}

function storeSummary(env = process.env) {
  const selected = storeName(env);
  return {
    selected,
    supported: ["database", "memory"],
    ready: selected === "database" || selected === "memory",
    shared: selected === "database",
    gatewaySafe: selected === "database",
  };
}

function ticketHash(ticket) {
  return crypto.createHash("sha256").update(String(ticket)).digest("hex");
}

function parseClaims(value) {
  try {
    const claims = JSON.parse(String(value || "{}"));
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

function publicEntry(row) {
  if (!row) return null;
  return {
    purpose: row.purpose,
    appEnv: row.appEnv,
    resourceId: row.resourceId || null,
    claims: parseClaims(row.claimsJson),
    multiUser: !!row.multiUser,
    clientId: row.clientId || null,
    expiresAt: new Date(row.expiresAt).getTime(),
  };
}

function cleanupMemory(now = Date.now()) {
  for (const [hash, entry] of memoryTickets.entries()) {
    if (entry.expiresAt <= now) memoryTickets.delete(hash);
  }
  while (memoryTickets.size >= MEMORY_MAX_ENTRIES) {
    const oldest = memoryTickets.keys().next().value;
    if (!oldest) break;
    memoryTickets.delete(oldest);
  }
}

const RealtimeTicket = {
  storeSummary,

  issue: async function ({ ticket, entry }) {
    const hash = ticketHash(ticket);
    if (storeName() === "memory") {
      cleanupMemory();
      memoryTickets.set(hash, { ...entry });
      return publicEntry({
        ...entry,
        claimsJson: JSON.stringify(entry.claims),
      });
    }
    const claims = entry.claims || {};
    const expiresAt = new Date(entry.expiresAt);
    const authUserId = claims.authUserId ? Number(claims.authUserId) : null;
    const created = await authPrisma.auth_realtime_tickets.create({
      data: {
        ticketHash: hash,
        purpose: entry.purpose,
        appEnv: entry.appEnv,
        resourceId: entry.resourceId || null,
        claimsJson: JSON.stringify(claims),
        multiUser: !!entry.multiUser,
        clientId: entry.clientId || null,
        authUserId,
        expiresAt,
      },
    });
    void authPrisma.auth_realtime_tickets
      .deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date() } },
            { consumedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
          ],
        },
      })
      .catch((error) =>
        console.warn("[realtime-auth] Ticket cleanup deferred", {
          code: error?.code || "realtime_ticket_cleanup_failed",
        })
      );
    return publicEntry(created);
  },

  consumeLocal: async function (ticket) {
    const hash = ticketHash(ticket);
    if (storeName() === "memory") {
      cleanupMemory();
      const entry = memoryTickets.get(hash) || null;
      memoryTickets.delete(hash);
      if (!entry || entry.expiresAt <= Date.now()) return null;
      return entry;
    }

    const row = await authPrisma.auth_realtime_tickets.findUnique({
      where: { ticketHash: hash },
    });
    if (!row || row.expiresAt <= new Date() || row.consumedAt) return null;
    const claimed = await authPrisma.auth_realtime_tickets.updateMany({
      where: {
        ticketHash: hash,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    return claimed.count === 1 ? publicEntry(row) : null;
  },

  consume: async function (ticket) {
    const identityClient = require("../utils/authz/identityOperationsClient");
    if (identityClient.remoteIdentityOperationsEnabled())
      return identityClient.consumeRealtimeTicketViaIdentity(ticket);
    return RealtimeTicket.consumeLocal(ticket);
  },

  _internals: { cleanupMemory, memoryTickets, storeName, ticketHash },
};

module.exports = { RealtimeTicket };
