const TimeOff = require('../models/TimeOff.model');
const S = require('./scheduling.util');

// Time-off periods of a chef that touch the date range [fromStr, toStr] ("YYYY-MM-DD")
const loadBlocks = (chefId, fromStr, toStr) =>
    TimeOff.find({ chef: chefId, startDate: { $lte: toStr }, endDate: { $gte: fromStr } }).lean();

// The busy intervals those blocks create on ONE date (same shape the scheduler uses for bookings)
const intervalsFor = (blocks, dateStr) =>
    blocks
        .filter((b) => b.startDate <= dateStr && b.endDate >= dateStr)
        .map((b) => b.allDay
            ? { startMinutes: 0, endMinutes: 1440, noBuffer: true, allDay: true }
            : { startMinutes: S.parseTime(b.startTime), endMinutes: S.parseTime(b.endTime), noBuffer: true });

module.exports = { loadBlocks, intervalsFor };
