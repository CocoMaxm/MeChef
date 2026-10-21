// Time-slot logic. All times are "minutes since midnight" in the chef's LOCAL time.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STEP_MINUTES = 30;          // start times are offered on the hour / half hour
const MIN_DURATION_MINUTES = 120; // matches the Booking model (min 2 hours)
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const parseTime = (s) => (typeof s === 'string' && TIME_RE.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null);
const formatTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Rest/travel time kept free around every booking (env: BOOKING_BUFFER_MINUTES, default 60)
const getBuffer = () => {
    const n = Number(process.env.BOOKING_BUFFER_MINUTES);
    return Number.isFinite(n) && n >= 0 ? n : 60;
};
// Minimum notice before a booking starts (env: BOOKING_MIN_LEAD_HOURS, default 12). Set 0 for testing.
const getMinLeadMinutes = () => {
    const n = Number(process.env.BOOKING_MIN_LEAD_HOURS);
    return (Number.isFinite(n) && n >= 0 ? n : 12) * 60;
};

// A stored booking -> { start, end }. Falls back to startTime/duration for older bookings
// that were saved before startMinutes/endMinutes existed; unreadable ones block the whole day.
const slotOf = (b) => {
    const start = b.startMinutes ?? parseTime(b.startTime);
    if (start === null || start === undefined) return { start: 0, end: 1440 };
    return { start, end: b.endMinutes ?? start + Number(b.duration || 0) * 60 };
};

// Do [start,end) and an existing booking collide, keeping `buffer` minutes free around it?
const conflicts = (existing, start, end, buffer = getBuffer()) =>
    existing.some((b) => {
        const s = slotOf(b);
        const pad = b.noBuffer ? 0 : buffer; // chef time-off needs no travel/rest buffer
        return start < s.end + pad && s.start < end + pad;
    });

// All start times (HH:MM) a booking of `durationMinutes` could begin at
const freeStartTimes = (existing, workingHours, durationMinutes, buffer = getBuffer()) => {
    const open = parseTime(workingHours?.start) ?? 8 * 60;
    const close = parseTime(workingHours?.end) ?? 22 * 60;
    const times = [];
    for (let t = open; t + durationMinutes <= close; t += STEP_MINUTES) {
        if (!conflicts(existing, t, t + durationMinutes, buffer)) times.push(formatTime(t));
    }
    return times;
};

// Is there still room for even the shortest booking?
const isDayFull = (existing, workingHours, buffer = getBuffer()) =>
    freeStartTimes(existing, workingHours, MIN_DURATION_MINUTES, buffer).length === 0;

const weekdayName = (date) => WEEKDAYS[new Date(date).getUTCDay()]; // dates are stored as UTC midnight of the calendar day
const dateKey = (date) => new Date(date).toISOString().split('T')[0];

// "Now" in a given IANA timezone -> { dateStr: 'YYYY-MM-DD', minutes }
const localNow = (timezone) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
};

// Minutes between "now" (in `timezone`) and the start of a booking on `dateStr` at `startMinutes`
const leadMinutes = (dateStr, startMinutes, timezone) => {
    const now = localNow(timezone);
    const dayDiff = Math.round((Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${now.dateStr}T00:00:00Z`)) / 86400000);
    return dayDiff * 1440 + startMinutes - now.minutes;
};

module.exports = {
    TIME_RE, STEP_MINUTES, MIN_DURATION_MINUTES, parseTime, formatTime, getBuffer, getMinLeadMinutes,
    slotOf, conflicts, freeStartTimes, isDayFull, weekdayName, dateKey, localNow, leadMinutes
};
