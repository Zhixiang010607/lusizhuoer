// Display only: use the recorded punch coordinates, never the viewer's location.
function attendanceMap(record = {}) {
  const latitude = coordinate(record.latitude, 90), longitude = coordinate(record.longitude, 180);
  const mapReady = latitude !== null && longitude !== null;
  const punchLabel = record.attendanceType === "CLOCK_OUT" ? "下班打卡" : "上班打卡";
  return {
    mapReady, latitude, longitude,
    markers: mapReady ? [{ id: 1, latitude, longitude, title: String(record.placeName || `${punchLabel}位置`), width: 28, height: 28 }] : []
  };
}
function coordinate(value, limit) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}
module.exports = { attendanceMap };
