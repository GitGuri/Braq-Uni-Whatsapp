import './_setup.js';
import { describe, test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

// Business hours are defined in South African local time (RETAIL_HOURS template).
// Run the local-time boundary tests with the process TZ pinned to SAST so they are
// deterministic on any machine.
const ORIGINAL_TZ = process.env.TZ;
let isWithinBusinessHours;

before(async () => {
  process.env.TZ = 'Africa/Johannesburg';
  ({ isWithinBusinessHours } = await import(src('core/businessHours.js')));
});
after(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

// SAST is UTC+2 with no DST, so local wall time = UTC + 2h.
const sast = (iso) => new Date(`${iso}+02:00`);

describe('isWithinBusinessHours — weekday (Mon–Fri 08:00–17:00)', () => {
  // 2026-10-19 is a Monday, 2026-10-23 a Friday.
  const cases = [
    ['2026-10-19T00:00:00', false, 'Mon midnight'],
    ['2026-10-19T07:59:00', false, 'Mon 07:59 (one minute before open)'],
    ['2026-10-19T07:59:59', false, 'Mon 07:59:59 (seconds ignored → still 7:59)'],
    ['2026-10-19T08:00:00', true,  'Mon 08:00 (open minute, inclusive)'],
    ['2026-10-19T12:30:00', true,  'Mon midday'],
    ['2026-10-19T16:59:00', true,  'Mon 16:59 (last open minute)'],
    ['2026-10-19T16:59:59', true,  'Mon 16:59:59'],
    ['2026-10-19T17:00:00', false, 'Mon 17:00 (close minute, exclusive)'],
    ['2026-10-19T23:59:00', false, 'Mon 23:59'],
    ['2026-10-21T08:00:00', true,  'Wed 08:00'],
    ['2026-10-23T16:59:00', true,  'Fri 16:59'],
    ['2026-10-23T17:00:00', false, 'Fri 17:00'],
  ];
  for (const [iso, expected, label] of cases) {
    test(`${label} → ${expected}`, () => {
      assert.equal(isWithinBusinessHours(sast(iso)), expected);
    });
  }
});

describe('isWithinBusinessHours — Saturday (08:00–13:00)', () => {
  const cases = [
    ['2026-10-24T07:59:00', false, 'Sat 07:59'],
    ['2026-10-24T08:00:00', true,  'Sat 08:00'],
    ['2026-10-24T12:59:00', true,  'Sat 12:59'],
    ['2026-10-24T13:00:00', false, 'Sat 13:00 (close, exclusive)'],
    ['2026-10-24T15:00:00', false, 'Sat 15:00 (weekday hours do not apply)'],
  ];
  for (const [iso, expected, label] of cases) {
    test(`${label} → ${expected}`, () => {
      assert.equal(isWithinBusinessHours(sast(iso)), expected);
    });
  }
});

describe('isWithinBusinessHours — Sunday (closed all day)', () => {
  for (const t of ['00:00', '08:00', '10:00', '12:59', '16:59', '23:59']) {
    test(`Sun ${t} → false`, () => {
      assert.equal(isWithinBusinessHours(sast(`2026-10-25T${t}:00`)), false);
    });
  }
});

describe('isWithinBusinessHours — default argument uses the current clock', () => {
  afterEach(() => mock.timers.reset());

  test('mocked now = Tue 10:00 SAST → open', () => {
    mock.timers.enable({ apis: ['Date'], now: sast('2026-10-20T10:00:00').getTime() });
    assert.equal(isWithinBusinessHours(), true);
  });

  test('mocked now = Tue 17:00 SAST → closed', () => {
    mock.timers.enable({ apis: ['Date'], now: sast('2026-10-20T17:00:00').getTime() });
    assert.equal(isWithinBusinessHours(), false);
  });

  test('mocked now = Sun 10:00 SAST → closed', () => {
    mock.timers.enable({ apis: ['Date'], now: sast('2026-10-25T10:00:00').getTime() });
    assert.equal(isWithinBusinessHours(), false);
  });
});

describe('isWithinBusinessHours — public holidays (template: "Sunday & Public Holidays: Closed")', () => {
  // South African public holidays (fixed dates, Sunday→Monday observed rule,
  // Good Friday and Family Day via Easter) are closed all day.
  const holidays = [
    ['2026-12-25T10:00:00', 'Christmas Day (Fri)'],
    ['2026-09-24T10:00:00', 'Heritage Day (Thu)'],
    ['2026-04-03T10:00:00', 'Good Friday 2026'],
    ['2026-04-06T10:00:00', 'Family Day 2026 (Easter Monday)'],
    ['2025-04-18T10:00:00', 'Good Friday 2025'],
    ['2027-03-29T10:00:00', 'Family Day 2027'],
    ['2026-08-10T10:00:00', 'Women\'s Day observed (9 Aug 2026 is a Sunday)'],
    ['2026-01-01T10:00:00', 'New Year\'s Day'],
  ];
  for (const [iso, label] of holidays) {
    test(`${label} 10:00 SAST should be closed`, () => {
      assert.equal(isWithinBusinessHours(sast(iso)), false);
    });
  }

  test('ordinary weekday next to a holiday stays open (Tue 2026-08-11 10:00)', () => {
    assert.equal(isWithinBusinessHours(sast('2026-08-11T10:00:00')), true);
  });

  test('holiday on a UTC server: 2026-12-24T23:30Z is 01:30 on Christmas Day SAST → closed, 2026-12-24T08:00Z open', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      assert.equal(isWithinBusinessHours(new Date('2026-12-24T23:30:00Z')), false);
      assert.equal(isWithinBusinessHours(new Date('2026-12-24T08:00:00Z')), true);
    } finally {
      process.env.TZ = saved;
    }
  });
});

describe('isWithinBusinessHours — timezone handling', () => {
  // Production servers typically run in UTC. The function uses Date#getHours()
  // (server-local time), so on a UTC host the opening window is shifted by 2h.
  let saved;
  before(() => { saved = process.env.TZ; process.env.TZ = 'UTC'; });
  after(() => { process.env.TZ = saved; });

  test('Tue 17:30 SAST (15:30 UTC) on a UTC server should be closed', () => {
    assert.equal(isWithinBusinessHours(new Date('2026-10-20T15:30:00Z')), false);
  });

  test('Tue 08:30 SAST (06:30 UTC) on a UTC server should be open', () => {
    assert.equal(isWithinBusinessHours(new Date('2026-10-20T06:30:00Z')), true);
  });

  test('Sat 13:30 SAST (11:30 UTC) on a UTC server should be closed', () => {
    assert.equal(isWithinBusinessHours(new Date('2026-10-24T11:30:00Z')), false);
  });

  test('Tue 12:00 SAST (10:00 UTC) on a UTC server is open (inside both windows)', () => {
    assert.equal(isWithinBusinessHours(new Date('2026-10-20T10:00:00Z')), true);
  });
});
