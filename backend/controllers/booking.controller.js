const Booking = require('../models/Booking.model');
const Chef = require('../models/Chef.model');
const sendEmail = require('../utils/email.util');
const { escapeHtml } = require('../utils/helpers.util');
const { getCountry } = require('../config/countries');
const { formatMoney } = require('../utils/money.util');
const S = require('../utils/scheduling.util');
const T = require('../utils/timeoff.util');
const { validateAddress } = require('../utils/address.util');
const { getReason } = require('../config/bookingReasons');

const ACTIVE = ['confirmed', 'pending', 'in-progress'];

// The calendar day, stored as 00:00 UTC (so it never shifts with the server's timezone)
const toDay = (value) => {
    const d = new Date(value);
    if (isNaN(d)) return null;
    d.setUTCHours(0, 0, 0, 0);
    return d;
};

// pending requests are accepted ('confirmed') or declined ('rejected');
// an accepted booking can later be completed or cancelled. Declining/cancelling needs a reason.
const TRANSITIONS = {
    pending: ['confirmed', 'rejected'],
    confirmed: ['completed', 'cancelled'],
    'in-progress': ['completed', 'cancelled']
};

const fail = (res, status, error) => res.status(status).json({ success: false, error });

// @route POST /api/bookings  (private, customer)
exports.createBooking = async (req, res, next) => {
    try {
        const { chefId, date, startTime, duration, numberOfGuests, address, specialRequests } = req.body;

        const day = toDay(date);
        if (!day) return fail(res, 400, 'Valid date is required');

        const start = S.parseTime(startTime);
        if (start === null || start % S.STEP_MINUTES !== 0) {
            return fail(res, 400, 'Start time must be HH:MM, on the hour or half hour');
        }
        const hours = Number(duration);
        if (!Number.isInteger(hours)) return fail(res, 400, 'Duration must be a whole number of hours');
        const end = start + hours * 60;

        const chef = await Chef.findById(chefId).populate('user');
        if (!chef || !chef.isVerified || !chef.isActive) return fail(res, 404, 'Chef not found');

        const country = getCountry(chef.serviceLocation && chef.serviceLocation.country);
        const addressError = validateAddress(address, country);
        if (addressError) return fail(res, 400, addressError);

        // 1. Does the chef work that weekday?
        const dateStr = S.dateKey(day);
        const weekday = S.weekdayName(day);
        const dayFlag = chef.availability && chef.availability.get && chef.availability.get(weekday);
        if (dayFlag === false) return fail(res, 400, `The chef does not work on ${weekday}s`);

        // 2. Inside the chef's working hours?
        const wh = { start: chef.workingHours?.start || '08:00', end: chef.workingHours?.end || '22:00' };
        const open = S.parseTime(wh.start) ?? 480;
        const close = S.parseTime(wh.end) ?? 1320;
        if (start < open || end > close) {
            return fail(res, 400, `The chef works between ${wh.start} and ${wh.end}; this booking would end at ${S.formatTime(Math.min(end, 1440))}`);
        }

        // 3. Not in the past, and enough notice (in the chef's local time)
        const lead = S.leadMinutes(dateStr, start, country.timezone);
        if (lead < 0) return fail(res, 400, 'This date and time is in the past');
        if (lead < S.getMinLeadMinutes()) {
            return fail(res, 400, `Bookings need at least ${S.getMinLeadMinutes() / 60} hours notice`);
        }

        // 4a. Has the chef blocked this time off in advance?
        const blockItems = T.intervalsFor(await T.loadBlocks(chef._id, dateStr, dateStr), dateStr);
        if (S.conflicts(blockItems, start, end, 0)) {
            return fail(res, 409, 'The chef is unavailable at that time. Please pick another time or date.');
        }

        // 4b. Does the time slot collide with another booking (plus the buffer)?
        const sameDay = await Booking.find({ chef: chef._id, date: day, status: { $in: ACTIVE } })
            .select('startTime startMinutes endMinutes duration');
        if (S.conflicts(sameDay, start, end)) {
            return fail(res, 409, 'The chef is not available at that time. Please pick another time or date.');
        }

        const totalPrice = chef.hourlyRate * hours;

        const booking = await Booking.create({
            customer: req.user.id,
            chef: chef._id,
            date: day,
            startTime: S.formatTime(start),
            startMinutes: start,
            endMinutes: end,
            duration: hours,
            numberOfGuests,
            country: country.code,
            currency: country.currency,
            address: {
                street: String(address.street).trim(),
                city: String(address.city).trim(),
                state: String(address.state || '').trim(),
                zipCode: String(address.zipCode || '').trim(),
                country: country.code
            },
            specialRequests,
            totalPrice
        });

        // 5. Race-condition guard: two customers can pass step 4 at the same moment.
        //    The booking with the LOWER _id wins; the other one removes itself and reports a clash.
        const earlier = await Booking.find({
            chef: chef._id, date: day, status: { $in: ACTIVE }, _id: { $lt: booking._id }
        }).select('startTime startMinutes endMinutes duration');
        if (S.conflicts(earlier, start, end)) {
            await booking.deleteOne();
            return fail(res, 409, 'Someone just booked that time. Please pick another time.');
        }

        const when = `${dateStr}, ${S.formatTime(start)} - ${S.formatTime(end % 1440)}`;
        const price = formatMoney(totalPrice, country);
        await Promise.all([
            sendEmail.safe({
                email: chef.user.email,
                subject: 'New Booking Request',
                html: `
                    <h2>You have a new booking request!</h2>
                    <p><strong>When:</strong> ${when}</p>
                    <p><strong>Duration:</strong> ${hours} hours</p>
                    <p><strong>Number of Guests:</strong> ${Number(numberOfGuests)}</p>
                    <p><strong>Location:</strong> ${[address.street, address.city, address.state, address.zipCode].filter(Boolean).map(escapeHtml).join(', ')}</p>
                    ${specialRequests ? `<p><strong>Special Requests:</strong> ${escapeHtml(specialRequests)}</p>` : ''}
                    <p><strong>Total Price:</strong> ${price}</p>
                    <p>Please log in to your dashboard to confirm or decline this booking.</p>`
            }),
            sendEmail.safe({
                email: req.user.email,
                subject: 'Booking Request Submitted',
                html: `
                    <h2>Your booking request has been submitted!</h2>
                    <p>We've notified Chef ${escapeHtml(chef.user.firstName)} ${escapeHtml(chef.user.lastName)} about your request.</p>
                    <p><strong>When:</strong> ${when}</p>
                    <p><strong>Total Price:</strong> ${price}</p>
                    <p>You'll receive another email once the chef confirms your booking.</p>`
            })
        ]);

        res.status(201).json({ success: true, data: booking });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/bookings  (private)
exports.getMyBookings = async (req, res, next) => {
    try {
        let query;
        if (req.user.role === 'customer') {
            query = { customer: req.user.id };
        } else if (req.user.role === 'chef') {
            const chef = await Chef.findOne({ user: req.user.id });
            if (!chef) return res.status(200).json({ success: true, count: 0, data: [] });
            query = { chef: chef._id };
        } else {
            query = {};
        }

        const bookings = await Booking.find(query)
            .populate({ path: 'chef', populate: { path: 'user', select: 'firstName lastName' } })
            .populate('customer', 'firstName lastName email')
            .sort('-createdAt');

        res.status(200).json({ success: true, count: bookings.length, data: bookings });
    } catch (err) {
        next(err);
    }
};

// @route PUT /api/bookings/:id/status  (private, chef)
exports.updateBookingStatus = async (req, res, next) => {
    try {
        const { status } = req.body;

        const booking = await Booking.findById(req.params.id).populate('customer').populate('chef');
        if (!booking) return fail(res, 404, 'Booking not found');

        const chef = await Chef.findOne({ user: req.user.id });
        if (!chef || booking.chef._id.toString() !== chef._id.toString()) {
            return fail(res, 401, 'Not authorized to update this booking');
        }

        if (!(TRANSITIONS[booking.status] || []).includes(status)) {
            return fail(res, 400, `A ${booking.status} booking cannot be changed to ${status}`);
        }

        const country = getCountry(booking.country);
        if (status === 'completed') {
            const today = S.localNow(country.timezone).dateStr;
            if (S.dateKey(booking.date) > today) return fail(res, 400, 'A booking cannot be completed before its date');
        }

        const declining = status === 'rejected' || status === 'cancelled';
        const reason = declining ? getReason(req.body.reasonCode) : null;
        if (declining && !reason) return fail(res, 400, 'Please choose a reason');

        booking.status = status;
        if (declining) {
            booking.statusReason = { code: reason.code, note: String(req.body.reason || '').trim().slice(0, 300), at: new Date() };
        }
        await booking.save();

        const chefName = `${escapeHtml(req.user.firstName)} ${escapeHtml(req.user.lastName)}`;
        const when = `${S.dateKey(booking.date)} at ${escapeHtml(booking.startTime)}`;
        let subject, html;
        if (status === 'confirmed') {
            subject = 'Booking Confirmed!';
            html = `<h2>Great news! Your booking has been confirmed.</h2>
                <p>Chef ${chefName} has confirmed your booking for ${when}.</p>
                <p>The chef will cook for ${booking.duration} hours.</p>`;
        } else if (declining) {
            const verb = status === 'rejected' ? 'declined' : 'cancelled';
            const note = booking.statusReason.note ? `<p>Message from the chef: ${escapeHtml(booking.statusReason.note)}</p>` : '';
            subject = status === 'rejected' ? 'Booking Declined' : 'Booking Cancelled';
            html = `<h2>Your booking has been ${verb}.</h2>
                <p>Unfortunately, Chef ${chefName} had to ${status === 'rejected' ? 'decline' : 'cancel'} your booking for ${when}.</p>
                <p>Reason: ${escapeHtml(reason.label)}</p>${note}
                <p>Please visit our website to book another chef.</p>`;
        }
        if (subject) await sendEmail.safe({ email: booking.customer.email, subject, html });

        res.status(200).json({ success: true, data: booking });
    } catch (err) {
        next(err);
    }
};

// @route POST /api/bookings/:id/review  (private, customer)
exports.addReview = async (req, res, next) => {
    try {
        const { score, review } = req.body;

        const booking = await Booking.findById(req.params.id);
        if (!booking) return fail(res, 404, 'Booking not found');
        if (booking.customer.toString() !== req.user.id) return fail(res, 401, 'Not authorized to review this booking');
        if (booking.status !== 'completed') return fail(res, 400, 'Can only review completed bookings');
        if (booking.rating && booking.rating.score) return fail(res, 400, 'This booking has already been reviewed');

        booking.rating = { score, review, reviewDate: Date.now() };
        await booking.save();

        // Recalculate the chef's average from their rated bookings (small, projected query)
        const rated = await Booking.find({ chef: booking.chef, 'rating.score': { $exists: true } })
            .select('rating.score').lean();
        if (rated.length) {
            const total = rated.reduce((sum, b) => sum + b.rating.score, 0);
            await Chef.updateOne({ _id: booking.chef }, {
                $set: { rating: { average: Math.round((total / rated.length) * 10) / 10, count: rated.length } }
            });
        }

        res.status(200).json({ success: true, data: booking });
    } catch (err) {
        next(err);
    }
};
