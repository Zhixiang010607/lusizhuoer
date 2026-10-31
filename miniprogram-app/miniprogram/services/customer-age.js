const { businessToday, displayDateAny } = require("./query-tools");

// Kept in this client: no persisted age, API changes or business-picker changes.
function formatCustomerAge(value, today = businessToday()) {
  const birthText = displayDateAny(value);
  const match = birthText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return "—";
  const [year, month, day] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || birthText > today) return "—";
  const [currentYear, currentMonth, currentDay] = today.split("-").map(Number);
  const years = currentYear - year - (currentMonth < month || (currentMonth === month && currentDay < day) ? 1 : 0);
  return `${years} 岁`;
}

module.exports = { formatCustomerAge };
