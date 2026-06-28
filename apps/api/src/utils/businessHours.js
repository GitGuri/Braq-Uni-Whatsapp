// Mon–Fri 8:00–17:00, Sat 8:00–13:00, Sun/holidays closed — matches the RETAIL_HOURS template text.
export function isWithinBusinessHours(date = new Date()) {
  const day  = date.getDay(); // 0 = Sunday, 6 = Saturday
  const hour = date.getHours() + date.getMinutes() / 60;

  if (day === 0) return false;
  if (day === 6) return hour >= 8 && hour < 13;
  return hour >= 8 && hour < 17;
}
