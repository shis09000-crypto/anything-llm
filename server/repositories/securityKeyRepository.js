const prisma = require("../utils/prisma");

function json(value, fallback = null) {
  if (value === undefined) return fallback;
  return value === null || typeof value === "string"
    ? value
    : JSON.stringify(value);
}

function hydrate(record = null, fields = []) {
  if (!record) return record;
  const next = { ...record };
  for (const field of fields) {
    if (typeof next[field] !== "string") continue;
    try {
      next[field] = JSON.parse(next[field]);
    } catch {}
  }
  return next;
}

const SecurityKeyRepository = {
  dataDomain: "security-key-governance",
  repositoryName: "SecurityKeyRepository",

  async probeSample({ sql } = {}) {
    if (typeof sql !== "string" || !/^\s*SELECT\b/i.test(sql)) {
      throw new Error("security_key_probe_select_required");
    }
    return prisma.$queryRawUnsafe(sql);
  },

  async listRegistry({ purpose = null } = {}) {
    const rows = await prisma.security_key_registry.findMany({
      where: purpose ? { purpose } : undefined,
      orderBy: [{ purpose: "asc" }, { version: "desc" }],
    });
    return rows.map((row) => hydrate(row, ["metadata"]));
  },

  async activeRegistry({ purpose }) {
    const row = await prisma.security_key_registry.findFirst({
      where: { purpose, status: "active" },
      orderBy: { version: "desc" },
    });
    return hydrate(row, ["metadata"]);
  },

  async registryByKeyId({ keyId }) {
    const row = await prisma.security_key_registry.findUnique({
      where: { keyId },
    });
    return hydrate(row, ["metadata"]);
  },

  async createRegistry(data = {}) {
    const row = await prisma.security_key_registry.create({
      data: {
        ...data,
        metadata: json(data.metadata),
      },
    });
    return hydrate(row, ["metadata"]);
  },

  async updateRegistry({ keyId, updates = {} } = {}) {
    const row = await prisma.security_key_registry.update({
      where: { keyId },
      data: {
        ...updates,
        ...(Object.prototype.hasOwnProperty.call(updates, "metadata")
          ? { metadata: json(updates.metadata) }
          : {}),
      },
    });
    return hydrate(row, ["metadata"]);
  },

  async listBindings() {
    const rows = await prisma.security_key_domain_bindings.findMany({
      orderBy: { domain: "asc" },
    });
    return rows.map((row) => hydrate(row, ["coverage"]));
  },

  async upsertBinding({ domain, ...data } = {}) {
    const normalized = {
      ...data,
      coverage: json(data.coverage),
    };
    const row = await prisma.security_key_domain_bindings.upsert({
      where: { domain },
      create: { domain, ...normalized },
      update: normalized,
    });
    return hydrate(row, ["coverage"]);
  },

  async createRotationJob(data = {}) {
    const row = await prisma.security_key_rotation_jobs.create({
      data: { ...data, progress: json(data.progress) },
    });
    return hydrate(row, ["progress"]);
  },

  async rotationJob({ jobId = null, idempotencyKey = null } = {}) {
    const row = jobId
      ? await prisma.security_key_rotation_jobs.findUnique({ where: { jobId } })
      : idempotencyKey
        ? await prisma.security_key_rotation_jobs.findUnique({
            where: { idempotencyKey },
          })
        : null;
    return hydrate(row, ["progress"]);
  },

  async updateRotationJob({ jobId, updates = {} } = {}) {
    const row = await prisma.security_key_rotation_jobs.update({
      where: { jobId },
      data: {
        ...updates,
        ...(Object.prototype.hasOwnProperty.call(updates, "progress")
          ? { progress: json(updates.progress) }
          : {}),
      },
    });
    return hydrate(row, ["progress"]);
  },

  async listRotationJobs({ limit = 50 } = {}) {
    const rows = await prisma.security_key_rotation_jobs.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(Number(limit) || 50, 200)),
    });
    return rows.map((row) => hydrate(row, ["progress"]));
  },

  async appendEvent(data = {}) {
    const row = await prisma.security_key_events.create({
      data: { ...data, metadata: json(data.metadata) },
    });
    return hydrate(row, ["metadata"]);
  },

  async listEvents({ limit = 100, keyId = null, jobId = null } = {}) {
    const rows = await prisma.security_key_events.findMany({
      where: {
        ...(keyId ? { keyId } : {}),
        ...(jobId ? { jobId } : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: Math.max(1, Math.min(Number(limit) || 100, 500)),
    });
    return rows.map((row) => hydrate(row, ["metadata"]));
  },
};

module.exports = { SecurityKeyRepository };
