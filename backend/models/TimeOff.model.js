const mongoose = require('mongoose');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// A period the chef is NOT available, set in advance.
//  - allDay: true  -> every day from startDate to endDate (inclusive) is blocked
//  - allDay: false -> only startTime-endTime is blocked on each day of the range
// Dates are plain "YYYY-MM-DD" strings (calendar days in the chef's own time zone).
const timeOffSchema = new mongoose.Schema({
    chef: { type: mongoose.Schema.Types.ObjectId, ref: 'Chef', required: true },
    startDate: { type: String, required: true, match: DATE_RE },
    endDate: { type: String, required: true, match: DATE_RE },
    allDay: { type: Boolean, default: true },
    startTime: { type: String, match: TIME_RE },
    endTime: { type: String, match: TIME_RE },
    note: { type: String, maxlength: 200 }, // private to the chef, never shown to customers
    createdAt: { type: Date, default: Date.now }
});

timeOffSchema.index({ chef: 1, endDate: 1 });

module.exports = mongoose.model('TimeOff', timeOffSchema);
