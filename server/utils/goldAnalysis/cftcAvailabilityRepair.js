const { marketDataEnvelope } = require("./marketDataEnvelope");
const { resolveCotRelease } = require("./cftcReleaseCalendar");

function parseEnvelope(row) {
  try {
    const envelope = JSON.parse(row.envelope_json);
    if (
      envelope?.source !== "cftc" ||
      envelope?.eventType !== "cot_disaggregated"
    )
      return null;
    return envelope;
  } catch {
    return null;
  }
}

function repairCftcObservation(row) {
  const envelope = parseEnvelope(row);
  if (!envelope) return null;
  const reportDate = new Date(Number(row.observed_at_ms))
    .toISOString()
    .slice(0, 10);
  const release = resolveCotRelease(reportDate);
  const nextEnvelope = marketDataEnvelope({
    source: envelope.source,
    market: envelope.market,
    eventType: envelope.eventType,
    observedAtMs: envelope.observedAtMs,
    receivedAtMs: envelope.receivedAtMs,
    availableAtMs: release.availableAtMs,
    availabilityQuality: release.availabilityQuality,
    revisionStatus: envelope.revisionStatus,
    backfilled: envelope.backfilled,
    formingCandleExcluded: envelope.formingCandleExcluded,
    providerVersion: "cftc-disaggregated-v2",
    citationUrl: release.citationUrl,
  });
  const nextEnvelopeJson = JSON.stringify(nextEnvelope);
  const timestampShiftMs = release.availableAtMs - Number(row.available_at_ms);
  const changed =
    row.event_id !== nextEnvelope.eventId ||
    Number(row.available_at_ms) !== release.availableAtMs ||
    row.envelope_json !== nextEnvelopeJson;
  return {
    changed,
    reportDate,
    release,
    oldEventId: row.event_id,
    newEventId: nextEnvelope.eventId,
    oldAvailableAtMs: Number(row.available_at_ms),
    newAvailableAtMs: release.availableAtMs,
    timestampShiftMs,
    oldEnvelope: envelope,
    nextEnvelope,
    nextEnvelopeJson,
    payloadJson: row.payload_json,
  };
}

function planCftcAvailabilityRepairs(db) {
  const rows = db
    .prepare(
      `SELECT event_id, observed_at_ms, available_at_ms,
              envelope_json, payload_json
       FROM normalized_observations
       WHERE source = 'cftc'
       ORDER BY observed_at_ms`
    )
    .all();
  const evaluated = rows.map(repairCftcObservation);
  const candidates = evaluated.filter((candidate) => candidate?.changed);
  const shifted = candidates.filter(
    (candidate) => candidate.timestampShiftMs !== 0
  );
  return {
    scanned: rows.length,
    invalid: evaluated.filter((candidate) => candidate === null).length,
    changed: candidates.length,
    timestampShifted: shifted.length,
    futureLeakCorrections: shifted.filter(
      (candidate) => candidate.timestampShiftMs > 0
    ).length,
    exact: candidates.filter(
      (candidate) => candidate.release.availabilityQuality === "exact"
    ).length,
    officialSchedule: candidates.filter(
      (candidate) =>
        candidate.release.availabilityQuality === "official_schedule"
    ).length,
    estimated: candidates.filter(
      (candidate) => candidate.release.availabilityQuality === "estimated"
    ).length,
    maxDelayCorrectionMs: shifted.reduce(
      (maximum, candidate) =>
        Math.max(maximum, Math.max(0, candidate.timestampShiftMs)),
      0
    ),
    candidates,
  };
}

function applyCftcAvailabilityRepairs(db, candidates = []) {
  const find = db.prepare(
    `SELECT event_id, payload_json
     FROM normalized_observations
     WHERE event_id = ?`
  );
  const update = db.prepare(
    `UPDATE normalized_observations
     SET event_id = ?, available_at_ms = ?, envelope_json = ?
     WHERE event_id = ?`
  );
  const remove = db.prepare(
    `DELETE FROM normalized_observations WHERE event_id = ?`
  );
  const transaction = db.transaction((items) => {
    let applied = 0;
    let merged = 0;
    for (const candidate of items) {
      if (!candidate.changed) continue;
      const existing =
        candidate.newEventId === candidate.oldEventId
          ? null
          : find.get(candidate.newEventId);
      if (existing) {
        if (existing.payload_json !== candidate.payloadJson)
          throw new Error("cftc_repair_event_conflict");
        remove.run(candidate.oldEventId);
        merged += 1;
      } else {
        const result = update.run(
          candidate.newEventId,
          candidate.newAvailableAtMs,
          candidate.nextEnvelopeJson,
          candidate.oldEventId
        );
        if (result.changes !== 1) throw new Error("cftc_repair_row_missing");
      }
      applied += 1;
    }
    return { applied, merged };
  });
  return transaction(candidates);
}

module.exports = {
  applyCftcAvailabilityRepairs,
  planCftcAvailabilityRepairs,
  repairCftcObservation,
};
