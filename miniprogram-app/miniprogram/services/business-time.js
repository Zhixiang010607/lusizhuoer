const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, "0");
}

function fromMilliseconds(milliseconds) {
  const date = new Date(milliseconds + SHANGHAI_OFFSET_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function formatShanghaiTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return fromMilliseconds(value.getTime());
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw)) {
    const milliseconds = Date.parse(raw);
    if (Number.isFinite(milliseconds)) return fromMilliseconds(milliseconds);
  }
  return raw.replace("T", " ").slice(0, 19);
}

module.exports = { formatShanghaiTimestamp };
