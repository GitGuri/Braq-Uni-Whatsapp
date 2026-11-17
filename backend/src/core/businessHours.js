// Mon–Fri 8:00–17:00, Sat 8:00–13:00, Sun/public holidays closed — matches the RETAIL_HOURS template text.
// Always evaluated in South African time (Africa/Johannesburg), regardless of the host's TZ.

const BUSINESS_TZ = 'Africa/Johannesburg';

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

// Wall-clock parts of `date` in Johannesburg time.
function sastParts(date) {
  const p = {};
  for (const { type, value } of partsFormatter.formatToParts(date)) p[type] = value;
  return {
    year:    Number(p.year),
    month:   Number(p.month), // 1-12
    day:     Number(p.day),
    weekday: WEEKDAYS[p.weekday],
    hour:    Number(p.hour) % 24,
    minute:  Number(p.minute),
  };
}

// Anonymous Gregorian algorithm → Easter Sunday { month (1-12), day }
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

// Fixed-date South African public holidays as [month, day]
const FIXED_HOLIDAYS = [
  [1, 1],   // New Year's Day
  [3, 21],  // Human Rights Day
  [4, 27],  // Freedom Day
  [5, 1],   // Workers' Day
  [6, 16],  // Youth Day
  [8, 9],   // National Women's Day
  [9, 24],  // Heritage Day
  [12, 16], // Day of Reconciliation
  [12, 25], // Christmas Day
  [12, 26], // Day of Goodwill
];

const holidayCache = new Map();

const key = (month, day) => `${month}-${day}`;

// Set of "M-D" keys for every public holiday (incl. observed Mondays) in `year`.
function publicHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const set = new Set();

  for (const [month, day] of FIXED_HOLIDAYS) {
    set.add(key(month, day));
    // Public Holidays Act: a holiday falling on a Sunday is observed on the Monday
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow === 0) {
      const observed = new Date(Date.UTC(year, month - 1, day + 1));
      set.add(key(observed.getUTCMonth() + 1, observed.getUTCDate()));
    }
  }

  const easter = easterSunday(year);
  const easterUtc = Date.UTC(year, easter.month - 1, easter.day);
  const goodFriday = new Date(easterUtc - 2 * 86400000);
  const familyDay  = new Date(easterUtc + 1 * 86400000);
  set.add(key(goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()));
  set.add(key(familyDay.getUTCMonth() + 1, familyDay.getUTCDate()));

  holidayCache.set(year, set);
  return set;
}

export function isPublicHoliday(date = new Date()) {
  const { year, month, day } = sastParts(date);
  return publicHolidays(year).has(key(month, day));
}

export function isWithinBusinessHours(date = new Date()) {
  const { year, month, day, weekday, hour: h, minute } = sastParts(date);
  const hour = h + minute / 60;

  if (weekday === 0) return false;
  if (publicHolidays(year).has(key(month, day))) return false;
  if (weekday === 6) return hour >= 8 && hour < 13;
  return hour >= 8 && hour < 17;
}
