const Chef = require('../models/Chef.model');
const Booking = require('../models/Booking.model');
const { escapeRegex } = require('../utils/helpers.util');
const { COUNTRIES, getCountry } = require('../config/countries');
const { formatMoney } = require('../utils/money.util');
const S = require('../utils/scheduling.util');
const TimeOff = require('../models/TimeOff.model');
const T = require('../utils/timeoff.util');

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ACTIVE = ['confirmed', 'pending', 'in-progress'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

const chefCountry = (chef) => getCountry(chef.serviceLocation && chef.serviceLocation.country) || getCountry();
const chefHours = (chef) => ({
    start: chef.workingHours?.start || '08:00',
    end: chef.workingHours?.end || '22:00'
});
const isWorkingDay = (chef, date) => {
    const avail = chef.availability;
    const v = avail && (typeof avail.get === 'function' ? avail.get(S.weekdayName(date)) : avail[S.weekdayName(date)]);
    return v !== false; // missing = available
};

// @route GET /api/chefs?country=KE&city=&cuisine=&minPrice=&maxPrice=&minRating=&sortBy=  (public)
exports.getChefs = async (req, res, next) => {
    try {
        const { cuisine, city, state, country, minPrice, maxPrice, minRating, sortBy } = req.query;

        const query = { isActive: true, isVerified: true };
        if (country) {
            const c = getCountry(country);
            if (!c) return res.status(400).json({ success: false, error: 'Unsupported country' });
            query['serviceLocation.country'] = c.code;
        }
        if (cuisine) {
            const cuisineName = String(cuisine).trim().slice(0, 60);
            const escapedCuisine = new RegExp(`^${escapeRegex(cuisineName)}$`, 'i');
            query.$or = [
                { cuisineSpecialization: escapedCuisine },
                { additionalCuisines: escapedCuisine }
            ];
        }
        if (city) query['serviceLocation.city'] = new RegExp(escapeRegex(city), 'i');
        if (state) query['serviceLocation.state'] = new RegExp(escapeRegex(state), 'i');
        if (minPrice || maxPrice) {
            query.hourlyRate = {};
            if (minPrice) query.hourlyRate.$gte = Number(minPrice);
            if (maxPrice) query.hourlyRate.$lte = Number(maxPrice);
        }
        if (minRating) query['rating.average'] = { $gte: Number(minRating) };

        let sort = {};
        if (sortBy === 'price-low') sort.hourlyRate = 1;
        else if (sortBy === 'price-high') sort.hourlyRate = -1;
        else if (sortBy === 'rating') sort['rating.average'] = -1;
        else sort.createdAt = -1;

        const chefs = await Chef.find(query).populate('user', 'firstName lastName').sort(sort).lean();
        // Attach the currency so the UI can show "KES 3,000/hour" without a second request
        const data = chefs.map((c) => ({ ...c, currency: chefCountry(c).currency }));

        res.status(200).json({ success: true, count: data.length, data });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/chefs/:id  (public, verified chefs only)
exports.getChef = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ _id: req.params.id, isVerified: true, isActive: true })
            .populate('user', 'firstName lastName').lean();
        if (!chef) return res.status(404).json({ success: false, error: 'Chef not found' });
        res.status(200).json({ success: true, data: { ...chef, currency: chefCountry(chef).currency } });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/chefs/me  (private, chef)
exports.getMyProfile = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user.id }).populate('user', 'firstName lastName email').lean();
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        res.status(200).json({ success: true, data: { ...chef, currency: chefCountry(chef).currency } });
    } catch (err) {
        next(err);
    }
};

// @route PUT /api/chefs/:id  (private, chef)
// Only whitelisted fields are applied, and nested objects are merged field-by-field
// (so changing the city can never wipe the country or working hours).
exports.updateChef = async (req, res, next) => {
    try {
        const chef = await Chef.findById(req.params.id);
        if (!chef) return res.status(404).json({ success: false, error: 'Chef not found' });
        if (chef.user.toString() !== req.user.id) {
            return res.status(401).json({ success: false, error: 'Not authorized to update this profile' });
        }

        const b = req.body;
        const $set = {};
        ['bio', 'experience', 'cuisineSpecialization', 'hourlyRate'].forEach((f) => {
            if (b[f] !== undefined) $set[f] = b[f];
        });
        ['additionalCuisines', 'signatureDishes'].forEach((f) => {
            if (Array.isArray(b[f])) {
                const maxLength = f === 'signatureDishes' ? 80 : 60;
                const maxItems = f === 'signatureDishes' ? 8 : 10;
                $set[f] = [...new Set(b[f].map((item) => String(item).trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
            }
        });
        if (b.profileImage !== undefined) {
            const image = String(b.profileImage || '').trim();
            if (image) {
                let parsed;
                try { parsed = new URL(image); } catch (e) { return res.status(400).json({ success: false, error: 'Profile photo must be a valid HTTPS image link' }); }
                if (parsed.protocol !== 'https:' || parsed.username || parsed.password || image.length > 500) {
                    return res.status(400).json({ success: false, error: 'Profile photo must be a valid HTTPS image link' });
                }
            }
            $set.profileImage = image || null;
        }

        if (b.serviceLocation && typeof b.serviceLocation === 'object') {
            ['city', 'state', 'country', 'maxTravelDistance'].forEach((f) => {
                if (b.serviceLocation[f] !== undefined) {
                    $set[`serviceLocation.${f}`] = f === 'country' ? String(b.serviceLocation[f]).toUpperCase() : b.serviceLocation[f];
                }
            });
        }

        if (b.workingHours && typeof b.workingHours === 'object') {
            const start = b.workingHours.start ?? chefHours(chef).start;
            const end = b.workingHours.end ?? chefHours(chef).end;
            const s = S.parseTime(start), e = S.parseTime(end);
            if (s === null || e === null || e - s < S.MIN_DURATION_MINUTES) {
                return res.status(400).json({ success: false, error: 'Working hours must be HH:MM and span at least 2 hours' });
            }
            $set['workingHours.start'] = start;
            $set['workingHours.end'] = end;
        }

        if (b.availability && typeof b.availability === 'object') {
            for (const day of WEEKDAYS) {
                if (b.availability[day] !== undefined) $set[`availability.${day}`] = Boolean(b.availability[day]);
            }
        }

        // The minimum rate depends on the (possibly new) country
        const country = getCountry($set['serviceLocation.country'] || chefCountry(chef).code);
        if (!country) return res.status(400).json({ success: false, error: 'Unsupported country' });
        const rate = $set.hourlyRate !== undefined ? Number($set.hourlyRate) : chef.hourlyRate;
        if (!Number.isFinite(rate) || rate < country.minHourlyRate) {
            return res.status(400).json({
                success: false,
                error: `Hourly rate must be at least ${formatMoney(country.minHourlyRate, country)} in ${country.name}`
            });
        }

        await Chef.updateOne({ _id: req.params.id }, { $set }, { runValidators: true });
        const updated = await Chef.findById(req.params.id);
        res.status(200).json({ success: true, data: updated });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/chefs/:id/availability?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD  (public)
// data  = dates the calendar should show as unavailable (fully booked OR the chef's day off)
// meta  = working hours, days off, and the booked time ranges per date
exports.getChefAvailability = async (req, res, next) => {
    try {
        const { startDate, endDate } = req.query;
        if (!DATE_RE.test(startDate || '') || !DATE_RE.test(endDate || '')) {
            return res.status(400).json({ success: false, error: 'startDate and endDate must be YYYY-MM-DD' });
        }
        const start = new Date(`${startDate}T00:00:00Z`);
        const end = new Date(`${endDate}T00:00:00Z`);
        if (isNaN(start) || isNaN(end) || end < start || (end - start) / 86400000 > MAX_RANGE_DAYS) {
            return res.status(400).json({ success: false, error: `Date range must be valid and at most ${MAX_RANGE_DAYS} days` });
        }

        const chef = await Chef.findById(req.params.id);
        if (!chef || !chef.isVerified || !chef.isActive) {
            return res.status(404).json({ success: false, error: 'Chef not found' });
        }

        const bookings = await Booking.find({
            chef: chef._id, date: { $gte: start, $lte: end }, status: { $in: ACTIVE }
        }).select('date startTime startMinutes endMinutes duration');

        const byDate = {};
        bookings.forEach((bk) => { (byDate[S.dateKey(bk.date)] ||= []).push(bk); });

        const blocks = await T.loadBlocks(chef._id, startDate, endDate);
        const hours = chefHours(chef);
        const unavailable = [];
        const bookedSlots = {};
        const blockedSlots = {};
        const daysOff = WEEKDAYS.filter((d) => {
            const v = chef.availability && chef.availability.get && chef.availability.get(d);
            return v === false;
        });

        for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
            const key = S.dateKey(d);
            const day = byDate[key] || [];
            if (day.length) {
                bookedSlots[key] = day.map((bk) => {
                    const s = S.slotOf(bk);
                    return { start: S.formatTime(s.start), end: s.end >= 1440 ? '24:00' : S.formatTime(s.end) };
                });
            }
            const dayBlocks = T.intervalsFor(blocks, key);
            if (dayBlocks.length) {
                blockedSlots[key] = dayBlocks.map((b) => (b.allDay
                    ? { start: '00:00', end: '24:00', allDay: true }
                    : { start: S.formatTime(b.startMinutes), end: S.formatTime(b.endMinutes), allDay: false }));
            }
            if (!isWorkingDay(chef, d) || S.isDayFull([...day, ...dayBlocks], hours)) unavailable.push(key);
        }

        res.status(200).json({
            success: true,
            data: unavailable,
            meta: {
                workingHours: hours, daysOff, bufferMinutes: S.getBuffer(), bookedSlots, blockedSlots,
                // planned time off, shown to customers (the chef's private note is NOT included)
                timeOff: blocks.map((b) => ({ id: b._id, startDate: b.startDate, endDate: b.endDate, allDay: b.allDay, startTime: b.startTime, endTime: b.endTime }))
            }
        });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/chefs/:id/slots?date=YYYY-MM-DD&duration=3  (public)
// The start times a customer can actually pick for that day and length of booking.
exports.getChefSlots = async (req, res, next) => {
    try {
        const { date } = req.query;
        const duration = req.query.duration === undefined ? 3 : Number(req.query.duration);
        if (!DATE_RE.test(date || '') || isNaN(new Date(`${date}T00:00:00Z`))) {
            return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
        }
        if (!Number.isInteger(duration) || duration < 2 || duration > 8) {
            return res.status(400).json({ success: false, error: 'duration must be a whole number between 2 and 8 hours' });
        }

        const chef = await Chef.findById(req.params.id);
        if (!chef || !chef.isVerified || !chef.isActive) {
            return res.status(404).json({ success: false, error: 'Chef not found' });
        }

        const day = new Date(`${date}T00:00:00Z`);
        const country = chefCountry(chef);
        const hours = chefHours(chef);
        const base = { success: true, date, duration, workingHours: hours, timezone: country.timezone };

        if (!isWorkingDay(chef, day)) {
            return res.status(200).json({ ...base, slots: [], reason: 'The chef does not work on this day' });
        }

        const bookings = await Booking.find({ chef: chef._id, date: day, status: { $in: ACTIVE } })
            .select('startTime startMinutes endMinutes duration');
        const dayBlocks = T.intervalsFor(await T.loadBlocks(chef._id, date, date), date);
        if (dayBlocks.some((b) => b.allDay)) {
            return res.status(200).json({ ...base, slots: [], reason: 'The chef is unavailable on this day' });
        }

        const minLead = S.getMinLeadMinutes();
        const slots = S.freeStartTimes([...bookings, ...dayBlocks], hours, duration * 60)
            .filter((t) => S.leadMinutes(date, S.parseTime(t), country.timezone) >= minLead);

        res.status(200).json({ ...base, slots, reason: slots.length ? undefined : 'No free time for this length of booking on this day' });
    } catch (err) {
        next(err);
    }
};

// ---------------------------------------------------------------------------
// Chef time off: periods set in advance when the chef is NOT available
// ---------------------------------------------------------------------------
const toBool = (v, fallback) => (v === undefined ? fallback : v === true || v === 'true');

// @route GET /api/chefs/me/time-off  (private, chef) - current and upcoming periods
exports.listMyTimeOff = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user.id });
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        const today = S.localNow(chefCountry(chef).timezone).dateStr;
        const data = await TimeOff.find({ chef: chef._id, endDate: { $gte: today } }).sort({ startDate: 1, startTime: 1 }).lean();
        res.status(200).json({ success: true, count: data.length, data });
    } catch (err) {
        next(err);
    }
};

// @route POST /api/chefs/me/time-off  (private, chef)
// body: { startDate, endDate, allDay (default true), startTime, endTime (when allDay is false), note }
exports.addTimeOff = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user.id });
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });

        const { startDate, endDate, startTime, endTime } = req.body;
        const allDay = toBool(req.body.allDay, true);
        const bad = (error) => res.status(400).json({ success: false, error });

        if (!DATE_RE.test(startDate || '') || !DATE_RE.test(endDate || '') ||
            isNaN(new Date(`${startDate}T00:00:00Z`)) || isNaN(new Date(`${endDate}T00:00:00Z`))) {
            return bad('startDate and endDate must be valid dates (YYYY-MM-DD)');
        }
        if (endDate < startDate) return bad('The end date cannot be before the start date');
        if ((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 > 365) {
            return bad('A time-off period can be at most one year long');
        }
        if (endDate < S.localNow(chefCountry(chef).timezone).dateStr) return bad('Time off cannot be in the past');

        let s = null, e = null;
        if (!allDay) {
            s = S.parseTime(startTime);
            e = S.parseTime(endTime);
            if (s === null || e === null) return bad('startTime and endTime must be HH:MM when the period is not all day');
            if (e - s < 30) return bad('The end time must be at least 30 minutes after the start time');
        }
        if (await TimeOff.countDocuments({ chef: chef._id, endDate: { $gte: startDate } }) >= 200) {
            return bad('Too many time-off periods. Delete old ones first.');
        }

        const timeOff = await TimeOff.create({
            chef: chef._id, startDate, endDate, allDay,
            startTime: allDay ? undefined : startTime, endTime: allDay ? undefined : endTime,
            note: req.body.note ? String(req.body.note).trim().slice(0, 200) : undefined
        });

        // Existing bookings are NOT cancelled automatically; tell the chef which ones clash
        const affected = await Booking.find({
            chef: chef._id, status: { $in: ACTIVE },
            date: { $gte: new Date(`${startDate}T00:00:00Z`), $lte: new Date(`${endDate}T00:00:00Z`) }
        }).select('date startTime startMinutes endMinutes duration status');
        const warnings = affected
            .filter((b) => {
                const slot = S.slotOf(b);
                return allDay || S.conflicts([{ startMinutes: slot.start, endMinutes: slot.end }], s, e, 0);
            })
            .map((b) => ({ bookingId: b._id, date: S.dateKey(b.date), startTime: b.startTime, status: b.status }));

        res.status(201).json({ success: true, data: timeOff, warnings });
    } catch (err) {
        next(err);
    }
};

// @route DELETE /api/chefs/me/time-off/:id  (private, chef)
exports.deleteTimeOff = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user.id });
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        const removed = await TimeOff.findOneAndDelete({ _id: req.params.id, chef: chef._id });
        if (!removed) return res.status(404).json({ success: false, error: 'Time-off period not found' });
        res.status(200).json({ success: true, data: {} });
    } catch (err) {
        next(err);
    }
};
