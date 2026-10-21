// Run ONCE when you switch on email confirmation:   npm run verify-existing
// Marks every account that already exists as "email confirmed", so people who signed up before this feature
// are not asked to confirm. Accounts created after this feature stay unconfirmed until the person clicks the emailed link.
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User.model');

(async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const res = await User.updateMany({ emailVerified: { $ne: true } }, { $set: { emailVerified: true } });
        console.log(`Marked ${res.modifiedCount} existing account(s) as confirmed.`);
    } catch (err) {
        console.error(err);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close();
    }
})();
