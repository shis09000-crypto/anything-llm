const calendar = require("./contracts/cftc-release-calendar-v1.json");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateIsoDate(value) {
  const normalized = String(value || "").trim();
  if (!ISO_DATE.test(normalized)) throw new Error("cftc_report_date_invalid");
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== normalized
  )
    throw new Error("cftc_report_date_invalid");
  return normalized;
}

function easternWallClockMs(date, hour = 15, minute = 30) {
  const normalized = validateIsoDate(date);
  const [year, month, day] = normalized.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 16));
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: calendar.timezone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(probe)
    .find(({ type }) => type === "timeZoneName")?.value;
  const match = String(zoneName || "GMT-5").match(
    /GMT([+-]\d{1,2})(?::(\d{2}))?/
  );
  const offsetMinutes =
    Number(match?.[1] || -5) * 60 +
    Math.sign(Number(match?.[1] || -5)) * Number(match?.[2] || 0);
  return Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
}

function nextFriday(reportDate) {
  const normalized = validateIsoDate(reportDate);
  const date = new Date(`${normalized}T00:00:00.000Z`);
  const daysUntilFriday = (5 - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntilFriday);
  return date.toISOString().slice(0, 10);
}

function resolveCotRelease(reportDate) {
  const normalized = validateIsoDate(reportDate);
  const registered = calendar.releases[normalized] || null;
  const releaseDate = registered?.releaseDate || nextFriday(normalized);
  const availabilityQuality = registered?.availabilityQuality || "estimated";
  return {
    reportDate: normalized,
    releaseDate,
    availableAtMs: easternWallClockMs(releaseDate),
    availabilityQuality,
    availabilityEstimated: availabilityQuality !== "exact",
    calendarVersion: calendar.calendarVersion,
    reason: registered?.reason || calendar.fallbackPolicy,
    evidenceKey: registered?.evidence || null,
    citationUrl: registered?.evidence
      ? calendar.citations[registered.evidence]
      : calendar.citations.releaseSchedule,
  };
}

if (
  calendar.schema !== "athena.gold.cftc-release-calendar" ||
  calendar.schemaVersion !== "1.0" ||
  calendar.calendarVersion !== "cftc-release-calendar-v1"
)
  throw new Error("cftc_release_calendar_invalid");

module.exports = {
  CFTC_RELEASE_CALENDAR: calendar,
  easternWallClockMs,
  nextFriday,
  resolveCotRelease,
};
