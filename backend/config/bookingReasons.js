// Reasons a chef can give when declining / cancelling a booking. "other" needs no explanation.
const REASONS = [
    { code: 'schedule_conflict', label: 'I have another commitment at that time' },
    { code: 'too_far', label: 'The location is too far for me' },
    { code: 'guest_count', label: 'The number of guests is too large for me' },
    { code: 'menu_request', label: 'I cannot prepare the requested menu' },
    { code: 'unwell', label: 'I am unwell or have a personal emergency' },
    { code: 'other', label: 'Other' }
];
const getReason = (code) => REASONS.find((r) => r.code === code) || null;
module.exports = { REASONS, getReason };
