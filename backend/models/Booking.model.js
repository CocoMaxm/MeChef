const mongoose = require('mongoose');
const { DEFAULT_COUNTRY, getCountry } = require('../config/countries');

const bookingSchema = new mongoose.Schema({
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    chef: { type: mongoose.Schema.Types.ObjectId, ref: 'Chef', required: true },

    // The calendar day (stored as 00:00 UTC) + the time slot on that day (chef's local time)
    date: { type: Date, required: true },
    startTime: { type: String, required: true, match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'Start time must be HH:MM (24-hour)'] },
    startMinutes: { type: Number, required: true, min: 0, max: 1439 },   // startTime as minutes since midnight
    endMinutes: { type: Number, required: true, min: 1, max: 1440 },     // startMinutes + duration

    duration: { type: Number, required: true, min: [2, 'Minimum booking duration is 2 hours'], max: [8, 'Maximum booking duration is 8 hours'] },
    numberOfGuests: { type: Number, required: true, min: [1, 'Minimum 1 guest'], max: [50, 'Maximum 50 guests'] },

    // Country + currency are copied from the chef at booking time, so old bookings never change
    country: { type: String, default: DEFAULT_COUNTRY },
    currency: { type: String, default: getCountry().currency },

    address: {
        street: { type: String, required: true },
        city: { type: String, required: true },
        state: { type: String, default: '' },     // county / state / province (required only in some countries)
        zipCode: { type: String, default: '' },   // postal code (required only in some countries)
        country: { type: String }
    },
    specialRequests: { type: String, maxlength: 1000 },
    menuType: { type: String, enum: ['chef-choice', 'custom', 'pre-set'], default: 'chef-choice' },
    totalPrice: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'confirmed', 'in-progress', 'completed', 'cancelled', 'rejected'], default: 'pending' },
    // Why the chef declined (rejected) or cancelled the booking; shown to the customer
    statusReason: { code: String, note: { type: String, maxlength: 300 }, at: Date },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'refunded'], default: 'pending' },
    rating: {
        score: { type: Number, min: 1, max: 5 },
        review: String,
        reviewDate: Date
    },
    cancellationReason: String,
    createdAt: { type: Date, default: Date.now }
});

bookingSchema.index({ chef: 1, date: 1, status: 1 });
bookingSchema.index({ customer: 1, createdAt: -1 });

module.exports = mongoose.model('Booking', bookingSchema);
