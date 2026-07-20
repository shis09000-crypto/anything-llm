const prisma = require("../utils/prisma");

async function releaseContentObjectReferences(tx, objectIds, deleteAfter) {
  const counts = new Map();
  for (const id of objectIds.filter(Boolean))
    counts.set(id, Number(counts.get(id) || 0) + 1);

  for (const [id, count] of counts.entries()) {
    await tx.content_objects.updateMany({
      where: { id, refCount: { gte: count } },
      data: { refCount: { decrement: count } },
    });
    const object = await tx.content_objects.findUnique({
      where: { id },
      select: { refCount: true, state: true },
    });
    if (object && object.refCount <= 0 && object.state !== "deleted") {
      await tx.content_objects.update({
        where: { id },
        data: { state: "delete_pending", deleteAfter },
      });
    }
  }
}

const RetentionRepository = {
  async sweepPatrolRuns({ cutoff, deleteAfter, limit }) {
    const rows = await prisma.system_patrol_runs.findMany({
      where: { status: { not: "running" }, startedAt: { lt: cutoff } },
      select: { id: true, reportObjectId: true },
      orderBy: { startedAt: "asc" },
      take: limit,
    });
    if (rows.length === 0)
      return { scanned: 0, deleted: 0, releasedObjects: 0 };

    const runIds = rows.map((row) => row.id);
    const objectIds = rows.map((row) => row.reportObjectId).filter(Boolean);
    await prisma.$transaction(async (tx) => {
      await tx.system_patrol_repairs.deleteMany({
        where: { runId: { in: runIds } },
      });
      await tx.system_patrol_runs.deleteMany({
        where: { id: { in: runIds } },
      });
      await releaseContentObjectReferences(tx, objectIds, deleteAfter);
    });
    return {
      scanned: rows.length,
      deleted: rows.length,
      releasedObjects: objectIds.length,
    };
  },

  async sweepExpiredUploads({ now, limit }) {
    const uploads = await prisma.chat_attachment_uploads.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true },
      orderBy: { expiresAt: "asc" },
      take: limit,
    });
    if (uploads.length === 0) return { deleted: 0 };
    const uploadIds = uploads.map((upload) => upload.id);
    await prisma.$transaction(async (tx) => {
      await tx.chat_attachment_upload_parts.deleteMany({
        where: { uploadId: { in: uploadIds } },
      });
      await tx.chat_attachment_uploads.deleteMany({
        where: { id: { in: uploadIds } },
      });
    });
    return { deleted: uploadIds.length };
  },

  async sweepOperationalRows({ eventLogCutoff, now }) {
    const [eventLogs, expiredReservations] = await prisma.$transaction([
      prisma.event_logs.deleteMany({
        where: { occurredAt: { lt: eventLogCutoff } },
      }),
      prisma.ai_budget_reservations.updateMany({
        where: { status: "reserved", expiresAt: { lte: now } },
        data: {
          status: "failed",
          failureCode: "reservation_expired",
          settledAt: now,
          updatedAt: now,
        },
      }),
    ]);
    return {
      eventLogs: Number(eventLogs.count || 0),
      expiredReservations: Number(expiredReservations.count || 0),
    };
  },
};

module.exports = { RetentionRepository };
