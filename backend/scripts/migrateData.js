// One-off upgrade of data created BEFORE multi-country + time slots existed.
// Safe to run more than once. Usage (backend root):  node scripts/migrateData.js
//  - chefs without a country      -> country KE, default working hours
//  - bookings without time fields -> startMinutes/endMinutes computed from startTime + duration,
//                                    country/currency copied from the chef (KE/KES if unknown)
// NOTE: prices that were entered in dollars stay as plain numbers; they are NOT converted.
// If your old data was only test data, it is simpler to wipe the database and start fresh.
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Chef = require('../models/Chef.model');
const Booking = require('../models/Booking.model');
const { getCountry } = require('../config/countries');
const { parseTime } = require('../utils/scheduling.util');

(async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);

        const chefRes = await Chef.updateMany(
            { 'serviceLocation.country': { $exists: false } },
            { $set: { 'serviceLocation.country': 'KE' } }
        );
        console.log(`Chefs updated: ${chefRes.modifiedCount}`);

        const bookings = await Booking.find({ startMinutes: { $exists: false } }).populate('chef', 'serviceLocation');
        let fixed = 0, skipped = 0;
        for (const b of bookings) {
            const start = parseTime(b.startTime);
            if (start === null) { skipped++; console.warn(`Skipped booking ${b._id}: unreadable startTime "${b.startTime}"`); continue; }
            const country = getCountry(b.chef && b.chef.serviceLocation && b.chef.serviceLocation.country) || getCountry();
            await Booking.updateOne({ _id: b._id }, {
                $set: { startMinutes: start, endMinutes: Math.min(start + b.duration * 60, 1440), country: country.code, currency: country.currency }
            });
            fixed++;
        }
        console.log(`Bookings updated: ${fixed}, skipped: ${skipped}`);
    } catch (err) {
        console.error(err);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close();
    }
})();
