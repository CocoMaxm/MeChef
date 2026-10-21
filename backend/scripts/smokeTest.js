// End-to-end test of the whole backend against a REAL database.
//
//  1. Start the server in one terminal:   npm run dev      (put BOOKING_MIN_LEAD_HOURS=0 in .env first)
//  2. Run this in another terminal:       npm run test:flow            (default http://localhost:5000/api)
//                                         node scripts/smokeTest.js https://your-app.onrender.com/api
//
// It creates throw-away users (emails start with "smoke-"), exercises every important rule,
// then deletes everything it created. It reads MONGODB_URI from .env (same database as the server).
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User.model');
const Chef = require('../models/Chef.model');
const Booking = require('../models/Booking.model');
const ChefApplication = require('../models/ChefApplication.model');
const TimeOff = require('../models/TimeOff.model');
const Meal = require('../models/Meal.model');
const MealPhoto = require('../models/MealPhoto.model');
const sharp = require('sharp');
const Order = require('../models/Order.model');

const BASE = process.argv[2] || `http://localhost:${process.env.PORT || 5000}/api`;
const RUN = Date.now().toString(36);
const PASSWORD = 'Test-pass-123';
const email = (name) => `smoke-${RUN}-${name}@example.test`;
// Stands in for "clicking the confirmation link in the email" (the real token is only in the email)
const verifyMail = (addr) => User.updateOne({ email: addr.toLowerCase() }, { emailVerified: true });
const dayFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
    if (ok) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

async function call(method, url, { token, json, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(`${BASE}${url}`, { method, headers, body });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 120) }; }
    return { status: res.status, data, ok: res.ok };
}
const msg = (r) => JSON.stringify(r.data).slice(0, 220);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const appForm = ({ phone = '+254712345678', photo = true } = {}) => {
    const f = new FormData();
    f.append('answers', JSON.stringify([{ question: 'Why cook?', answer: 'I love it' }]));
    f.append('phone', phone);
    f.append('preferredInterviewTimes', 'Weekdays after 5pm');
    if (photo) f.append('passportPhoto', new Blob([PNG], { type: 'image/png' }), 'passport.png');
    return f;
};
const chefPayload = (name, extra = {}) => ({
    firstName: name, lastName: 'Smoke', email: email(name), password: PASSWORD,
    bio: 'Smoke test chef', experience: 5, cuisineSpecialization: 'Kenyan', hourlyRate: 2000,
    serviceLocation: { city: 'Nairobi' }, ...extra
});
const booking = (chefId, date, startTime, duration = 3, address) => ({
    chefId, date, startTime, duration, numberOfGuests: 4,
    address: address || { street: 'Ngong Road 12', city: 'Nairobi', state: 'Nairobi' }
});
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

(async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log(`Testing ${BASE}`);

        // Full onboarding for a chef: application -> live interview -> approval (used for the US chef)
        const approveChef = async (chefId, chefToken, adminToken) => {
            await call('POST', '/auth/submit-application', { token: chefToken, form: appForm() });
            await call('POST', `/admin/chefs/${chefId}/interview`, { token: adminToken, json: { scheduledAt: inDays(2) } });
            await call('POST', `/admin/chefs/${chefId}/interview/complete`, { token: adminToken, json: { passed: true } });
            return call('POST', `/admin/verify-chef/${chefId}`, { token: adminToken, json: { status: true } });
        };

        section('1. Server and countries');
        let r = await call('GET', '/health');
        check('health endpoint answers', r.status === 200, msg(r));
        r = await call('GET', '/countries');
        check('countries list has Kenya as default', r.status === 200 && r.data.default === 'KE' && r.data.data.some((c) => c.code === 'KE' && c.currency === 'KES'), msg(r));
        check('countries carry dial codes for the phone picker', r.data.data.find((c) => c.code === 'KE').dialCode === '+254');

        section('2. Accounts and security');
        r = await call('POST', '/auth/register', { json: { firstName: 'Cus', lastName: 'One', email: email('cus1'), password: PASSWORD, role: 'admin' } });
        check('customer can register', r.status === 201, msg(r));
        check('role "admin" in the request is ignored', r.data.user && r.data.user.role === 'customer', msg(r));
        check('a new password sign-up starts with an UNCONFIRMED email', r.data.user.emailVerified === false, msg(r));
        const cus1 = r.data.token;
        r = await call('POST', '/auth/register', { json: { firstName: 'Cus', lastName: 'Two', email: email('cus2'), password: PASSWORD } });
        const cus2 = r.data.token;
        r = await call('POST', '/auth/register', { json: { firstName: 'Cus', lastName: 'One', email: email('cus1').toUpperCase(), password: PASSWORD } });
        check('duplicate email (different case) is rejected', r.status === 400, msg(r));
        r = await call('POST', '/auth/login', { json: { email: email('cus1'), password: 'wrong-password' } });
        check('wrong password is rejected', r.status === 401, msg(r));
        r = await call('GET', '/auth/me');
        check('/auth/me without a token is rejected', r.status === 401);

        section('3. Chef sign-up (Kenya) and country rules');
        r = await call('POST', '/auth/register-chef', { json: chefPayload('lowrate', { hourlyRate: 100 }) });
        check('Kenyan chef below the minimum rate is rejected', r.status === 400 && /at least/i.test(msg(r)), msg(r));
        r = await call('POST', '/auth/register-chef', { json: chefPayload('chefke', { serviceLocation: { city: 'Nairobi', country: 'xx' } }) });
        check('unsupported country is rejected', r.status === 400, msg(r));
        r = await call('POST', '/auth/register-chef', { json: chefPayload('chefke', { serviceLocation: { city: 'Nairobi', country: 'ke' } }) });
        check('Kenyan chef registers (country sent as "ke" is normalised to KE)', r.status === 201 && r.data.chef && r.data.chef.serviceLocation.country === 'KE', msg(r));
        const chefKeToken = r.data.token;
        const chefKe = r.data.chef && r.data.chef._id;
        r = await call('GET', '/auth/me', { token: chefKeToken });
        check('/auth/me returns the chef profile for a chef', r.status === 200 && r.data.chef && r.data.chef._id === chefKe, msg(r));
        r = await call('GET', '/chefs/me', { token: chefKeToken });
        check('/chefs/me works and includes currency KES', r.status === 200 && r.data.data.currency === 'KES', msg(r));
        r = await call('GET', '/chefs?country=KE');
        check('unapproved chef is NOT listed publicly', r.status === 200 && !r.data.data.some((c) => c._id === chefKe), msg(r));

        section('4. Application, mandatory live interview and approval');
        r = await call('POST', '/auth/submit-application', { token: chefKeToken, form: appForm() });
        check('a chef with an UNCONFIRMED email cannot apply yet (403 EMAIL_NOT_VERIFIED)', r.status === 403 && r.data.code === 'EMAIL_NOT_VERIFIED', msg(r));
        await verifyMail(email('chefke'));
        r = await call('POST', '/auth/submit-application', { token: chefKeToken, form: appForm({ photo: false }) });
        check('application without a passport photo is rejected', r.status === 400, msg(r));
        r = await call('POST', '/auth/submit-application', { token: chefKeToken, form: appForm({ phone: '' }) });
        check('application without a phone number is rejected', r.status === 400 && /phone/i.test(msg(r)), msg(r));
        r = await call('POST', '/auth/submit-application', { token: chefKeToken, form: appForm({ phone: '12345' }) });
        check('application with an invalid phone number is rejected', r.status === 400, msg(r));
        let form = new FormData();
        form.append('phone', '+254712345678');
        form.append('passportPhoto', new Blob(['not an image'], { type: 'text/plain' }), 'evil.txt');
        r = await call('POST', '/auth/submit-application', { token: chefKeToken, form });
        check('non-image/PDF upload is rejected with 400', r.status === 400, msg(r));
        r = await call('POST', '/auth/submit-application', { token: cus1, form: appForm() });
        check('a customer cannot submit a chef application', r.status === 403, msg(r));
        r = await call('POST', '/auth/submit-application', { token: chefKeToken, form: appForm({ phone: '+254 712-345 678' }) });
        check('valid application is accepted (spaces/dashes in the phone are cleaned)', r.status === 200, msg(r));
        r = await call('GET', '/auth/my-application', { token: chefKeToken });
        check('chef sees own application: submitted, phone saved, interview pending',
            r.status === 200 && r.data.data.applicationStatus === 'submitted' && r.data.data.phone === '+254712345678' && r.data.data.interview.status === 'pending', msg(r));
        check('chef never sees admin-only interview notes', !JSON.stringify(r.data).includes('"notes"'));

        const admin = await User.create({ firstName: 'Admin', lastName: 'Smoke', email: email('admin'), password: PASSWORD, role: 'admin' });
        r = await call('POST', '/auth/login', { json: { email: email('admin'), password: PASSWORD } });
        const adminToken = r.data.token;
        check('admin can log in', r.status === 200 && !!adminToken, msg(r));
        r = await call('GET', '/admin/pending-chefs', { token: cus1 });
        check('customer cannot open admin routes (403)', r.status === 403, msg(r));
        r = await call('GET', '/admin/pending-chefs');
        check('no token cannot open admin routes (401)', r.status === 401, msg(r));
        r = await call('GET', '/admin/pending-chefs', { token: adminToken });
        const pending = (r.data.data || []).find((c) => c._id === chefKe);
        check('admin sees the chef with phone number and interview status',
            r.status === 200 && pending && pending.application.phone === '+254712345678' && pending.application.interview.status === 'pending', msg(r));
        r = await fetch(`${BASE}/admin/chefs/${chefKe}/documents/passportPhoto`, { headers: { Authorization: `Bearer ${adminToken}` } });
        check('admin can open the passport photo', r.status === 200);
        r = await fetch(`${BASE}/admin/chefs/${chefKe}/documents/passportPhoto`);
        check('passport photo is NOT public', r.status === 401);

        r = await call('POST', `/admin/verify-chef/${chefKe}`, { token: adminToken, json: { status: 'maybe' } });
        check('verify with an invalid status is rejected', r.status === 400, msg(r));
        r = await call('POST', `/admin/verify-chef/${chefKe}`, { token: adminToken, json: { status: true } });
        check('CANNOT approve a chef who has not been interviewed', r.status === 400 && /interview/i.test(msg(r)), msg(r));
        r = await call('POST', `/admin/chefs/${chefKe}/interview`, { token: adminToken, json: { scheduledAt: inDays(-1) } });
        check('interview in the past is rejected', r.status === 400, msg(r));
        r = await call('POST', `/admin/chefs/${chefKe}/interview`, { token: adminToken, json: { scheduledAt: inDays(2), meetingLink: 'http://insecure.example.com' } });
        check('non-https meeting link is rejected', r.status === 400, msg(r));
        r = await call('POST', `/admin/chefs/${chefKe}/interview`, { token: cus1, json: { scheduledAt: inDays(2) } });
        check('a customer cannot schedule interviews', r.status === 403, msg(r));
        r = await call('POST', `/admin/chefs/${chefKe}/interview`, { token: adminToken, json: { scheduledAt: inDays(2), meetingLink: 'https://meet.example.com/abc' } });
        check('admin schedules the live interview', r.status === 200, msg(r));
        r = await call('GET', '/auth/my-application', { token: chefKeToken });
        check('chef sees the interview time and link', r.data.data.applicationStatus === 'interview-scheduled' && r.data.data.interview.status === 'scheduled' && r.data.data.interview.meetingLink === 'https://meet.example.com/abc', msg(r));
        r = await call('POST', `/admin/verify-chef/${chefKe}`, { token: adminToken, json: { status: true } });
        check('CANNOT approve while the interview is only scheduled', r.status === 400, msg(r));
        r = await call('POST', `/admin/chefs/${chefKe}/interview/complete`, { token: adminToken, json: { passed: true, notes: 'Strong candidate' } });
        check('admin records a passed interview', r.status === 200, msg(r));
        r = await call('GET', '/auth/my-application', { token: chefKeToken });
        check('chef status becomes "interviewed" (awaiting final approval)', r.data.data.applicationStatus === 'interviewed', msg(r));
        r = await call('POST', `/admin/chefs/${chefKe}/interview/complete`, { token: adminToken, json: { passed: true } });
        check('interview cannot be completed twice', r.status === 400, msg(r));
        r = await call('POST', `/admin/verify-chef/${chefKe}`, { token: adminToken, json: { status: true } });
        check('admin approves the chef after the passed interview', r.status === 200, msg(r));
        r = await call('GET', '/chefs?country=KE');
        const listed = r.data.data && r.data.data.find((c) => c._id === chefKe);
        check('approved chef is now listed, with currency KES', !!listed && listed.currency === 'KES', msg(r));
        r = await call('GET', '/cuisines?country=KE');
        check('cuisine stats work per country', r.status === 200 && r.data.data.some((c) => c.currency === 'KES'), msg(r));

        // failed interview path
        r = await call('POST', '/auth/register-chef', { json: chefPayload('chefno') });
        const chefNoToken = r.data.token, chefNo = r.data.chef && r.data.chef._id;
        await verifyMail(email('chefno'));
        await call('POST', '/auth/submit-application', { token: chefNoToken, form: appForm() });
        r = await call('POST', `/admin/chefs/${chefNo}/interview/complete`, { token: adminToken, json: { passed: false, notes: 'private note', reason: 'Please gain more experience' } });
        check('admin can fail an interview (the call can happen without scheduling first)', r.status === 200, msg(r));
        r = await call('GET', '/auth/my-application', { token: chefNoToken });
        check('failed interview rejects the application and shows the reason to the chef', r.data.data.applicationStatus === 'rejected' && r.data.data.reviewNote === 'Please gain more experience', msg(r));
        r = await call('POST', `/admin/verify-chef/${chefNo}`, { token: adminToken, json: { status: true } });
        check('a chef who failed the interview cannot be approved', r.status === 400, msg(r));
        r = await call('POST', '/auth/submit-application', { token: chefNoToken, form: appForm() });
        check('a rejected chef can re-apply', r.status === 200, msg(r));
        r = await call('GET', '/auth/my-application', { token: chefNoToken });
        check('re-applying starts a fresh interview stage', r.data.data.applicationStatus === 'submitted' && r.data.data.interview.status === 'pending', msg(r));

        section('5. Chef profile editing is protected');
        r = await call('PUT', `/chefs/${chefKe}`, { token: chefKeToken, json: { hourlyRate: 100 } });
        check('cannot lower the rate below the country minimum', r.status === 400, msg(r));
        r = await call('PUT', `/chefs/${chefKe}`, { token: chefKeToken, json: { isVerified: false, rating: { average: 5 }, hourlyRate: 2500, serviceLocation: { city: 'Karen' } } });
        check('edit works; isVerified/rating are ignored; country survives a city change',
            r.status === 200 && r.data.data.isVerified === true && r.data.data.rating.average === 0 &&
            r.data.data.serviceLocation.city === 'Karen' && r.data.data.serviceLocation.country === 'KE' && r.data.data.hourlyRate === 2500, msg(r));
        r = await call('PUT', `/chefs/${chefKe}`, { token: cus1, json: { bio: 'hacked' } });
        check('a customer cannot edit a chef profile', r.status === 403, msg(r));

        section('6. Time slots (Kenya)');
        const D = dayFromNow(3);
        r = await call('GET', `/chefs/${chefKe}/slots?date=${D}&duration=3`);
        check('empty day offers slots from 08:00 to 19:00', r.status === 200 && r.data.slots[0] === '08:00' && r.data.slots.includes('19:00') && !r.data.slots.includes('19:30'), msg(r));
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefKe, D, '12:00') });
        check('a customer with an UNCONFIRMED email cannot book yet (403 EMAIL_NOT_VERIFIED)', r.status === 403 && r.data.code === 'EMAIL_NOT_VERIFIED', msg(r));
        await verifyMail(email('cus1')); await verifyMail(email('cus2'));
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefKe, D, '12:00') });
        check('booking 12:00-15:00 works without a ZIP code (Kenya)', r.status === 201 && r.data.data.endMinutes === 900 && r.data.data.currency === 'KES' && r.data.data.country === 'KE', msg(r));
        const b1 = r.data.data && r.data.data._id;
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D, '14:00') });
        check('overlapping booking (14:00) is rejected with 409', r.status === 409, msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D, '15:30') });
        check('booking inside the 60-minute buffer (15:30) is rejected', r.status === 409, msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D, '09:00', 3) });
        check('booking that ends inside the buffer before 12:00 (09:00-12:00) is rejected', r.status === 409, msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D, '16:00') });
        check('booking 16:00-19:00 (after the buffer) works', r.status === 201, msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D, '07:00') });
        check('booking before opening hours is rejected', r.status === 400, msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D, '21:00') });
        check('booking that ends after closing time is rejected', r.status === 400, msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D, '10:15') });
        check('start time off the half-hour grid is rejected', r.status === 400, msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, dayFromNow(-1), '12:00') });
        check('booking in the past is rejected', r.status === 400, msg(r));
        r = await call('POST', '/bookings', { json: booking(chefKe, D, '08:00') });
        check('booking without logging in is rejected', r.status === 401);
        r = await call('POST', '/bookings', { token: chefKeToken, json: booking(chefKe, D, '08:00') });
        check('a chef cannot make a customer booking', r.status === 403);
        r = await call('GET', `/chefs/${chefKe}/slots?date=${D}&duration=3`);
        check('slots now only offer 08:00 (the one gap that fits 3h)', r.status === 200 && JSON.stringify(r.data.slots) === '["08:00"]', msg(r));
        r = await call('GET', `/chefs/${chefKe}/availability?startDate=${D}&endDate=${D}`);
        check('availability shows the booked time ranges', r.status === 200 && r.data.meta.bookedSlots[D] && r.data.meta.bookedSlots[D].length === 2, msg(r));
        check('day with a free gap is NOT marked fully booked', !r.data.data.includes(D));
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefKe, D, '08:00') });
        check('booking 08:00-11:00 works', r.status === 201, msg(r));
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefKe, D, '20:00', 2) });
        check('booking 20:00-22:00 works', r.status === 201, msg(r));
        r = await call('GET', `/chefs/${chefKe}/availability?startDate=${D}&endDate=${D}`);
        check('day is now marked fully booked', r.status === 200 && r.data.data.includes(D), msg(r));

        section('7. Chef time off (dates and times they are not available)');
        r = await call('GET', '/chefs/me/time-off', { token: cus1 });
        check('a customer cannot use the chef time-off endpoints', r.status === 403, msg(r));
        r = await call('POST', '/chefs/me/time-off', { token: chefKeToken, json: { startDate: dayFromNow(-3), endDate: dayFromNow(-2) } });
        check('time off in the past is rejected', r.status === 400, msg(r));
        r = await call('POST', '/chefs/me/time-off', { token: chefKeToken, json: { startDate: dayFromNow(6), endDate: dayFromNow(5) } });
        check('end date before start date is rejected', r.status === 400, msg(r));
        r = await call('POST', '/chefs/me/time-off', { token: chefKeToken, json: { startDate: dayFromNow(5), endDate: dayFromNow(5), allDay: false } });
        check('a time window without times is rejected', r.status === 400, msg(r));
        r = await call('POST', '/chefs/me/time-off', { token: chefKeToken, json: { startDate: dayFromNow(5), endDate: dayFromNow(5), allDay: false, startTime: '10:00', endTime: '10:15' } });
        check('a time window shorter than 30 minutes is rejected', r.status === 400, msg(r));

        const D5 = dayFromNow(5), D6 = dayFromNow(6);
        r = await call('POST', '/chefs/me/time-off', { token: chefKeToken, json: { startDate: D5, endDate: D5, allDay: true, note: 'private family matter' } });
        check('chef blocks a whole day in advance', r.status === 201 && Array.isArray(r.data.warnings) && r.data.warnings.length === 0, msg(r));
        r = await call('GET', `/chefs/${chefKe}/slots?date=${D5}&duration=3`);
        check('customers see no slots on a blocked day', r.status === 200 && r.data.slots.length === 0 && /unavailable/i.test(r.data.reason || ''), msg(r));
        r = await call('GET', `/chefs/${chefKe}/availability?startDate=${D5}&endDate=${D5}`);
        check('the blocked day shows as unavailable in the calendar', r.status === 200 && r.data.data.includes(D5), msg(r));
        check('customers see the time off but NOT the chef\'s private note', r.data.meta.timeOff.length === 1 && !JSON.stringify(r.data).includes('private family'));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D5, '12:00') });
        check('booking on a blocked day is rejected (chef unavailable)', r.status === 409 && /unavailable/i.test(msg(r)), msg(r));

        r = await call('POST', '/chefs/me/time-off', { token: chefKeToken, json: { startDate: D6, endDate: D6, allDay: false, startTime: '10:00', endTime: '12:00' } });
        check('chef blocks 10:00-12:00 on another day', r.status === 201, msg(r));
        r = await call('GET', `/chefs/${chefKe}/slots?date=${D6}&duration=3`);
        check('slots skip the blocked window (first 3h start is 12:00)', r.status === 200 && r.data.slots[0] === '12:00', msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D6, '09:00', 3) });
        check('booking that overlaps the blocked window (09:00-12:00) is rejected', r.status === 409, msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D6, '12:00', 3) });
        check('booking right after the blocked window (12:00) works - no buffer on time off', r.status === 201, msg(r));
        r = await call('GET', `/chefs/${chefKe}/availability?startDate=${D6}&endDate=${D6}`);
        check('partly blocked day is not marked fully unavailable', r.status === 200 && !r.data.data.includes(D6) && r.data.meta.blockedSlots[D6], msg(r));

        r = await call('POST', '/chefs/me/time-off', { token: chefKeToken, json: { startDate: D, endDate: D, allDay: false, startTime: '13:00', endTime: '14:00' } });
        check('time off over an existing booking is allowed but WARNS the chef', r.status === 201 && r.data.warnings.length >= 1, msg(r));
        const clashId = r.data.data && r.data.data._id;
        r = await call('GET', '/chefs/me/time-off', { token: chefKeToken });
        check('chef lists their upcoming time off', r.status === 200 && r.data.count >= 3, msg(r));
        r = await call('DELETE', `/chefs/me/time-off/${clashId}`, { token: chefKeToken });
        check('chef removes a time-off period', r.status === 200, msg(r));
        r = await call('DELETE', `/chefs/me/time-off/${clashId}`, { token: chefKeToken });
        check('removing it again returns 404', r.status === 404, msg(r));

        section('8. Two customers booking the same slot at the same moment');
        const D2 = dayFromNow(4);
        const results = await Promise.all([
            call('POST', '/bookings', { token: cus1, json: booking(chefKe, D2, '19:00') }),
            call('POST', '/bookings', { token: cus2, json: booking(chefKe, D2, '19:00') })
        ]);
        const codes = results.map((x) => x.status).sort();
        check('exactly one of the two succeeds (201 + 409)', codes[0] === 201 && codes[1] === 409, JSON.stringify(codes));
        const stored = await Booking.countDocuments({ chef: chefKe, date: new Date(`${D2}T00:00:00Z`) });
        check('only one booking was saved in the database', stored === 1, `saved: ${stored}`);

        section('9. Declining bookings with a reason, lifecycle and reviews');
        r = await call('GET', '/bookings/reason-codes');
        check('the list of decline reasons is available', r.status === 200 && r.data.data.length >= 5 && r.data.data.some((x) => x.code === 'other'), msg(r));
        const D7 = dayFromNow(7);
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefKe, D7, '12:00') });
        const b2 = r.data.data && r.data.data._id;
        check('customer requests a booking (pending)', r.status === 201 && r.data.data.status === 'pending', msg(r));
        r = await call('PUT', `/bookings/${b2}/status`, { token: cus1, json: { status: 'rejected', reasonCode: 'other' } });
        check('a customer cannot decline a booking', r.status === 403, msg(r));
        r = await call('PUT', `/bookings/${b2}/status`, { token: chefKeToken, json: { status: 'rejected' } });
        check('declining without a reason is rejected', r.status === 400 && /reason/i.test(msg(r)), msg(r));
        r = await call('PUT', `/bookings/${b2}/status`, { token: chefKeToken, json: { status: 'rejected', reasonCode: 'made_up' } });
        check('declining with an unknown reason is rejected', r.status === 400, msg(r));
        r = await call('PUT', `/bookings/${b2}/status`, { token: chefKeToken, json: { status: 'rejected', reasonCode: 'schedule_conflict', reason: 'Sorry, I am fully booked' } });
        check('chef declines with a reason and a short note', r.status === 200 && r.data.data.status === 'rejected' && r.data.data.statusReason.code === 'schedule_conflict' && r.data.data.statusReason.note === 'Sorry, I am fully booked', msg(r));
        r = await call('GET', '/bookings', { token: cus1 });
        const seen = r.data.data && r.data.data.find((b) => b._id === b2);
        check('the customer sees the decline reason on their dashboard', !!seen && seen.status === 'rejected' && seen.statusReason.note === 'Sorry, I am fully booked', msg(r));
        r = await call('POST', '/bookings', { token: cus2, json: booking(chefKe, D7, '12:00') });
        const b3 = r.data.data && r.data.data._id;
        check('a declined booking frees the time slot for someone else', r.status === 201, msg(r));
        r = await call('PUT', `/bookings/${b3}/status`, { token: chefKeToken, json: { status: 'confirmed' } });
        r = await call('PUT', `/bookings/${b3}/status`, { token: chefKeToken, json: { status: 'rejected', reasonCode: 'other' } });
        check('a confirmed booking cannot be "declined" (it must be cancelled)', r.status === 400, msg(r));
        r = await call('PUT', `/bookings/${b3}/status`, { token: chefKeToken, json: { status: 'cancelled' } });
        check('cancelling a confirmed booking also needs a reason', r.status === 400, msg(r));
        r = await call('PUT', `/bookings/${b3}/status`, { token: chefKeToken, json: { status: 'cancelled', reasonCode: 'unwell' } });
        check('chef cancels a confirmed booking by just choosing a reason (no note)', r.status === 200 && r.data.data.status === 'cancelled' && r.data.data.statusReason.code === 'unwell', msg(r));

        r = await call('PUT', `/bookings/${b1}/status`, { token: cus1, json: { status: 'confirmed' } });
        check('a customer cannot confirm a booking', r.status === 403, msg(r));
        r = await call('PUT', `/bookings/${b1}/status`, { token: chefKeToken, json: { status: 'completed' } });
        check('pending -> completed is not allowed', r.status === 400, msg(r));
        r = await call('PUT', `/bookings/${b1}/status`, { token: chefKeToken, json: { status: 'confirmed' } });
        check('chef confirms the booking', r.status === 200, msg(r));
        r = await call('PUT', `/bookings/${b1}/status`, { token: chefKeToken, json: { status: 'completed' } });
        check('cannot complete a booking before its date', r.status === 400, msg(r));
        await Booking.updateOne({ _id: b1 }, { date: new Date(`${dayFromNow(-1)}T00:00:00Z`) }); // pretend the event was yesterday
        r = await call('PUT', `/bookings/${b1}/status`, { token: chefKeToken, json: { status: 'completed' } });
        check('chef completes the booking once the date has passed', r.status === 200, msg(r));
        r = await call('POST', `/bookings/${b1}/review`, { token: cus2, json: { score: 5, review: 'Great' } });
        check('someone else cannot review the booking', r.status === 401, msg(r));
        r = await call('POST', `/bookings/${b1}/review`, { token: cus1, json: { score: 5, review: 'Great food' } });
        check('customer reviews the completed booking', r.status === 200, msg(r));
        r = await call('POST', `/bookings/${b1}/review`, { token: cus1, json: { score: 1, review: 'Again' } });
        check('a second review is rejected', r.status === 400, msg(r));
        r = await call('GET', `/chefs/${chefKe}`);
        check('chef rating is recalculated (5.0, 1 review)', r.status === 200 && r.data.data.rating.average === 5 && r.data.data.rating.count === 1, msg(r));
        r = await call('GET', '/bookings', { token: chefKeToken });
        check('chef sees their bookings', r.status === 200 && r.data.count >= 4, msg(r));
        r = await call('GET', '/bookings', { token: cus1 });
        check('customer sees only their own bookings', r.status === 200 && r.data.data.every((b) => b.customer._id === r.data.data[0].customer._id), msg(r));

        section('10. A second country (United States)');
        r = await call('POST', '/auth/register-chef', { json: chefPayload('chefus', { hourlyRate: 15, serviceLocation: { city: 'Austin', state: 'TX', country: 'US' } }) });
        check('US chef below the US minimum is rejected', r.status === 400, msg(r));
        r = await call('POST', '/auth/register-chef', { json: chefPayload('chefus', { hourlyRate: 50, serviceLocation: { city: 'Austin', state: 'TX', country: 'us' } }) });
        check('US chef registers (country is normalised to US)', r.status === 201 && r.data.chef.serviceLocation.country === 'US', msg(r));
        const chefUs = r.data.chef && r.data.chef._id;
        const chefUsToken = r.data.token;
        await verifyMail(email('chefus'));
        r = await approveChef(chefUs, r.data.token, adminToken);
        check('US chef goes through application, interview and approval', r.status === 200, msg(r));
        r = await call('GET', '/chefs?country=US');
        check('country filter lists only US chefs', r.status === 200 && r.data.data.length >= 1 && r.data.data.every((c) => c.serviceLocation.country === 'US' && c.currency === 'USD'), msg(r));
        r = await call('GET', '/chefs?country=KE');
        check('Kenyan list does not contain the US chef', !r.data.data.some((c) => c._id === chefUs));
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefUs, D, '12:00', 3, { street: '1 Congress Ave', city: 'Austin' }) });
        check('US booking without state is rejected', r.status === 400 && /state/i.test(msg(r)), msg(r));
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefUs, D, '12:00', 3, { street: '1 Congress Ave', city: 'Austin', state: 'TX' }) });
        check('US booking without ZIP is rejected', r.status === 400 && /zip/i.test(msg(r)), msg(r));
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefUs, D, '12:00', 3, { street: '1 Congress Ave', city: 'Austin', state: 'TX', zipCode: '78701', country: 'KE' }) });
        check('US chef cannot be booked for a Kenyan address', r.status === 400 && /only serves/i.test(msg(r)), msg(r));
        r = await call('POST', '/bookings', { token: cus1, json: booking(chefUs, D, '12:00', 3, { street: '1 Congress Ave', city: 'Austin', state: 'TX', zipCode: '78701' }) });
        check('valid US booking works and is priced in USD', r.status === 201 && r.data.data.currency === 'USD' && r.data.data.totalPrice === 150, msg(r));

        section('11. Food orders: kitchens, meals and delivery');
        r = await call('GET', '/kitchens/meta');
        check('the lists the website needs are available (cuisines, categories, dietary, delivery apps, reasons)', r.status === 200 && r.data.data.courierServices.some((x) => x.code === 'bolt') && r.data.data.orderReasons.length >= 5, msg(r));
        r = await call('GET', '/kitchens/me', { token: chefKeToken });
        check('a chef starts with a closed kitchen and no meals', r.status === 200 && r.data.data.enabled === false && r.data.data.isVerified === true && r.data.data.availableMeals === 0, msg(r));
        r = await call('PUT', '/kitchens/me', { token: cus1, json: { enabled: true } });
        check('a customer cannot change kitchen settings (403)', r.status === 403, msg(r));
        r = await call('PUT', '/kitchens/me', { token: chefKeToken, json: { enabled: true, name: 'Karen Kitchen' } });
        check('a kitchen cannot open without meals, phone and pickup address (400)', r.status === 400, msg(r));
        r = await call('PUT', '/kitchens/me', { token: chefKeToken, json: { phone: '12345' } });
        check('an invalid kitchen phone number is rejected', r.status === 400, msg(r));

        r = await call('POST', '/meals', { token: cus1, json: { name: 'Sneaky', price: 100 } });
        check('a customer cannot create meals (403)', r.status === 403, msg(r));
        r = await call('POST', '/meals', { token: chefKeToken, json: { name: 'Nyama Choma Plate', price: 0 } });
        check('a price of 0 is rejected', r.status === 400, msg(r));
        r = await call('POST', '/meals', { token: chefKeToken, json: { name: 'Nyama Choma Plate', price: 850, dietary: ['keto'] } });
        check('an unknown dietary option is rejected', r.status === 400, msg(r));
        r = await call('POST', '/meals', { token: chefKeToken, json: { name: 'Nyama Choma Plate', description: 'Grilled goat with kachumbari', price: 850, category: 'main', portion: 'Serves 1', prepMinutes: 40, dietary: ['halal', 'spicy'] } });
        check('chef adds a meal (cuisine defaults to their own: Kenyan)', r.status === 201 && r.data.data.cuisine === 'Kenyan' && r.data.data.price === 850, msg(r));
        const mMain = r.data.data._id;
        r = await call('POST', '/meals', { token: chefKeToken, json: { name: 'Mandazi (6 pieces)', price: 300, category: 'snack', dietary: ['vegetarian'] } });
        const mSnack = r.data.data._id;
        r = await call('POST', '/meals', { token: chefKeToken, json: { name: 'Fresh Passion Juice', price: 150, category: 'drink', dietary: ['vegan'] } });
        const mDrink = r.data.data._id;
        check('chef adds more meals', !!mSnack && !!mDrink, msg(r));
        r = await call('PUT', `/meals/${mMain}`, { token: chefKeToken, json: { price: 900 } });
        check('chef edits a meal', r.status === 200 && r.data.data.price === 900, msg(r));
        await call('PUT', `/meals/${mMain}`, { token: chefKeToken, json: { price: 850 } });
        r = await call('PUT', `/meals/${mMain}`, { token: chefUsToken, json: { price: 1 } });
        check('another chef cannot edit someone else\'s meal (404)', r.status === 404, msg(r));
        r = await call('GET', '/meals', { token: chefKeToken });
        check('chef lists their meals', r.status === 200 && r.data.count === 3, msg(r));

        r = await call('PUT', '/kitchens/me', { token: chefKeToken, json: {
            enabled: true, acceptingOrders: true, name: 'Karen Kitchen', tagline: 'Home-style Kenyan, cooked to order',
            deliveryAreas: ['Westlands', 'Kilimani', 'westlands'], phone: '+254 722 000 111',
            pickupAddress: { street: 'Ngong Rd 5', city: 'Nairobi', state: 'Nairobi' },
            fulfilment: { pickup: true, courier: true }, courierArrangedBy: 'chef', minOrder: 500 } });
        check('chef opens the kitchen; the phone is normalised and duplicate areas are removed', r.status === 200 && r.data.data.enabled && r.data.data.phone === '+254722000111' && r.data.data.deliveryAreas.length === 2, msg(r));
        r = await call('GET', `/chefs/${chefKe}`);
        const publicProfile = JSON.stringify(r.data);
        r = await call('GET', '/chefs?country=KE');
        check('the PUBLIC chef profile and chef list never expose the kitchen phone or pickup address', !publicProfile.includes('722000111') && !publicProfile.includes('Ngong Rd') && !JSON.stringify(r.data).includes('722000111'));

        const search = async (q) => (await call('GET', `/kitchens?${q}`)).data.data || [];
        const has = (list) => list.some((k) => k.chefId === chefKe);
        check('searching the kitchen\'s home city (Karen) finds it', has(await search('country=KE&city=Karen')));
        check('a delivery area the kitchen lists (Westlands) finds it', has(await search('country=KE&city=Nairobi&area=Westlands')));
        check('an area it does not list (Runda) does not', !has(await search('country=KE&area=Runda')));
        check('a listed area typed as the city (Kilimani) finds it', has(await search('country=KE&city=Kilimani')));
        check('another city (Mombasa) does not find it', !has(await search('country=KE&city=Mombasa')));
        check('cuisine filter: Kenyan finds it, Italian does not', has(await search('country=KE&cuisine=Kenyan')) && !has(await search('country=KE&cuisine=Italian')));
        check('dietary filter: vegan and halal find it, nut-free does not', has(await search('country=KE&dietary=vegan')) && has(await search('country=KE&dietary=halal')) && !has(await search('country=KE&dietary=nut_free')));
        check('country filter: it is not listed for the US', !has(await search('country=US')));
        r = await call('GET', '/kitchens?dietary=keto');
        check('an unknown dietary filter is rejected', r.status === 400, msg(r));
        r = await call('GET', '/kitchens?country=XX');
        check('an unsupported country is rejected', r.status === 400, msg(r));
        const card = (await search('country=KE&city=Karen')).find((k) => k.chefId === chefKe);
        check('the kitchen card shows name, price range, currency and meal count but no private details',
            card.kitchenName === 'Karen Kitchen' && card.currency === 'KES' && card.priceFrom === 150 && card.priceTo === 850 && card.mealCount === 3 && !JSON.stringify(card).includes('722000111'), JSON.stringify(card).slice(0, 200));
        r = await call('GET', `/kitchens/${chefKe}`);
        check('the kitchen page lists its meals', r.status === 200 && r.data.data.meals.length === 3 && !JSON.stringify(r.data).includes('Ngong Rd'), msg(r));
        await call('PUT', `/meals/${mDrink}`, { token: chefKeToken, json: { isAvailable: false } });
        r = await call('GET', `/kitchens/${chefKe}`);
        check('a meal switched off ("sold out") disappears from the customer\'s menu', r.data.data.meals.length === 2 && !r.data.data.meals.some((m) => m.name.includes('Juice')), msg(r));

        // --- placing orders
        const body = (extra = {}) => ({
            chefId: chefKe, items: [{ mealId: mMain, quantity: 2, price: 1 }, { mealId: mSnack, quantity: 1, note: 'extra sugar' }], fulfilment: 'delivery', phone: '+254 711 222 333',
            dropoff: { street: 'Waiyaki Way 10', area: 'Westlands', city: 'Nairobi', state: 'Nairobi', instructions: 'Call at the gate' }, notes: 'Less pepper please', ...extra });
        r = await call('POST', '/auth/register', { json: { firstName: 'Una', lastName: 'Unconfirmed', email: email('cus3'), password: PASSWORD } });
        const cus3 = r.data.token;
        r = await call('POST', '/orders', { token: cus3, json: body() });
        check('a customer with an UNCONFIRMED email cannot order yet (403)', r.status === 403 && r.data.code === 'EMAIL_NOT_VERIFIED', msg(r));
        r = await call('POST', '/orders', { json: body() });
        check('ordering without logging in is rejected (401)', r.status === 401);
        r = await call('POST', '/orders', { token: chefKeToken, json: body() });
        check('a chef cannot place a customer order (403)', r.status === 403);
        r = await call('POST', '/orders', { token: cus1, json: body({ items: [] }) });
        check('an empty order is rejected', r.status === 400, msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ items: [{ mealId: mMain, quantity: 0 }] }) });
        check('a quantity of 0 is rejected', r.status === 400, msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ items: [{ mealId: '507f1f77bcf86cd799439011', quantity: 1 }] }) });
        check('a meal that does not exist is rejected', r.status === 400, msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ items: [{ mealId: mDrink, quantity: 1 }, { mealId: mMain, quantity: 1 }] }) });
        check('an order containing a sold-out meal is rejected', r.status === 400 && /no longer available/i.test(msg(r)), msg(r));
        await call('PUT', `/meals/${mDrink}`, { token: chefKeToken, json: { isAvailable: true } });
        r = await call('POST', '/orders', { token: cus1, json: body({ items: [{ mealId: mDrink, quantity: 1 }] }) });
        check('an order below the kitchen\'s minimum is rejected', r.status === 400 && /minimum/i.test(msg(r)), msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ fulfilment: undefined }) });
        check('an order must say delivery or pickup', r.status === 400, msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ phone: '0711' }) });
        check('an invalid customer phone is rejected', r.status === 400, msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ dropoff: undefined }) });
        check('a delivery order needs an address', r.status === 400, msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ dropoff: { street: 'Beach Rd', area: 'Nyali', city: 'Mombasa' } }) });
        check('an address outside the delivery area is refused, listing where the kitchen delivers', r.status === 400 && /Westlands/.test(msg(r)), msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ dropoff: { street: 'Somewhere 1', city: 'Nairobi' } }) });
        check('a kitchen with listed areas needs the neighbourhood, not just the city', r.status === 400, msg(r));
        r = await call('POST', '/orders', { token: cus1, json: body({ dropoff: { street: 'Somewhere 1', area: 'Westlands', city: 'Nairobi', country: 'US' } }) });
        check('an address in another country is refused', r.status === 400, msg(r));

        r = await call('POST', '/orders', { token: cus1, json: body() });
        const o1 = r.data.data && r.data.data._id;
        check('customer places a delivery order (201, pending)', r.status === 201 && r.data.data.status === 'pending' && /^CM-[A-Z2-9]{5}$/.test(r.data.data.code), msg(r));
        check('the total is calculated by the SERVER from the menu (2 x 850 + 300), ignoring a tampered price', r.data.data.subtotal === 2000 && r.data.data.currency === 'KES' && r.data.data.items[0].price === 850, msg(r));
        check('the order remembers who books the rider (the chef)', r.data.data.courier.arrangedBy === 'chef');
        r = await call('GET', '/orders', { token: chefKeToken });
        const seenByChef = (r.data.data || []).find((o) => o._id === o1);
        check('chef sees the new order but NOT the customer\'s phone or street yet', !!seenByChef && seenByChef.customerPhone === null && !seenByChef.dropoff.street && seenByChef.dropoff.area === 'Westlands' && seenByChef.customerName === 'Cus One', JSON.stringify(seenByChef).slice(0, 220));
        r = await call('GET', '/orders', { token: cus1 });
        const seenByCust = (r.data.data || []).find((o) => o._id === o1);
        check('customer sees their order (kitchen name, no pickup details for a chef-arranged delivery)', !!seenByCust && seenByCust.chef.kitchenName === 'Karen Kitchen' && seenByCust.pickup === null, JSON.stringify(seenByCust).slice(0, 200));
        r = await call('GET', '/orders', { token: cus2 });
        check('another customer does not see it', !(r.data.data || []).some((o) => o._id === o1));
        r = await call('PUT', `/orders/${o1}/status`, { token: cus2, json: { status: 'cancelled' } });
        check('another customer cannot cancel it (403)', r.status === 403, msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: chefUsToken, json: { status: 'accepted', readyInMinutes: 30 } });
        check('another chef cannot accept it (403)', r.status === 403, msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: cus1, json: { status: 'accepted' } });
        check('a customer cannot accept their own order (403)', r.status === 403, msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: chefKeToken, json: { status: 'accepted' } });
        check('accepting needs a ready time', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: chefKeToken, json: { status: 'accepted', readyInMinutes: 500 } });
        check('a ready time over 4 hours is refused', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o1}/courier`, { token: chefKeToken, json: { service: 'bolt' } });
        check('a rider cannot be added before the order is accepted', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: chefKeToken, json: { status: 'accepted', readyInMinutes: 45 } });
        check('chef accepts with "ready in 45 minutes"', r.status === 200 && r.data.data.status === 'accepted' && Math.abs(new Date(r.data.data.readyAt) - (Date.now() + 45 * 60000)) < 120000, msg(r));
        check('after accepting, the chef sees the customer\'s phone and full address', r.data.data.customerPhone === '+254711222333' && r.data.data.dropoff.street === 'Waiyaki Way 10', msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: cus1, json: { status: 'cancelled' } });
        check('a customer cannot cancel once the chef accepted', r.status === 400, msg(r));

        r = await call('PUT', `/orders/${o1}/courier`, { token: cus1, json: { service: 'bolt' } });
        check('the customer cannot add rider details when the CHEF books the rider (403)', r.status === 403, msg(r));
        r = await call('PUT', `/orders/${o1}/courier`, { token: chefKeToken, json: { service: 'pigeon' } });
        check('an unknown delivery service is rejected', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o1}/courier`, { token: chefKeToken, json: { service: 'bolt', trackingLink: 'http://insecure.example.com' } });
        check('a tracking link must be https', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o1}/courier`, { token: chefKeToken, json: { service: 'bolt', riderPhone: '0733' } });
        check('an invalid rider phone is rejected', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o1}/courier`, { token: chefKeToken, json: { service: 'bolt', riderName: 'Joe', riderPhone: '+254 733 444 555', trackingLink: 'https://bolt.eu/track/abc' } });
        check('chef records the Bolt rider (name, phone, tracking link)', r.status === 200 && r.data.data.courier.service === 'bolt' && r.data.data.courier.riderPhone === '+254733444555', msg(r));
        r = await call('GET', '/orders', { token: cus1 });
        const withRider = r.data.data.find((o) => o._id === o1);
        check('the customer sees the rider details', withRider.courier.service === 'bolt' && withRider.courier.riderName === 'Joe' && withRider.courier.trackingLink === 'https://bolt.eu/track/abc');

        r = await call('PUT', `/orders/${o1}/status`, { token: chefKeToken, json: { status: 'completed' } });
        check('cannot jump from accepted straight to completed', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: chefKeToken, json: { status: 'preparing' } });
        check('chef: preparing', r.status === 200 && r.data.data.status === 'preparing', msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: chefKeToken, json: { status: 'ready' } });
        check('chef: ready', r.status === 200, msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: chefKeToken, json: { status: 'completed' } });
        check('chef: completed (handed to the rider)', r.status === 200 && r.data.data.status === 'completed', msg(r));
        r = await call('PUT', `/orders/${o1}/status`, { token: chefKeToken, json: { status: 'preparing' } });
        check('a completed order cannot go back', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o1}/courier`, { token: chefKeToken, json: { service: 'uber' } });
        check('rider details are locked once the order is completed', r.status === 400, msg(r));

        // decline with a reason
        r = await call('POST', '/orders', { token: cus1, json: body({ fulfilment: 'pickup', dropoff: undefined }) });
        const o2 = r.data.data._id;
        check('customer places a pickup order', r.status === 201 && r.data.data.fulfilment === 'pickup' && !r.data.data.courier.arrangedBy, msg(r));
        r = await call('PUT', `/orders/${o2}/status`, { token: chefKeToken, json: { status: 'rejected' } });
        check('declining needs a reason', r.status === 400 && /reason/i.test(msg(r)), msg(r));
        r = await call('PUT', `/orders/${o2}/status`, { token: chefKeToken, json: { status: 'rejected', reasonCode: 'made_up' } });
        check('an unknown reason is rejected', r.status === 400, msg(r));
        r = await call('GET', '/orders', { token: cus1 });
        check('before acceptance the customer sees NO pickup address or kitchen phone', r.data.data.find((o) => o._id === o2).pickup === null);
        r = await call('PUT', `/orders/${o2}/status`, { token: chefKeToken, json: { status: 'rejected', reasonCode: 'sold_out', reason: 'Sorry, the goat is finished' } });
        check('chef declines with a reason and a note', r.status === 200 && r.data.data.status === 'rejected', msg(r));
        r = await call('GET', '/orders', { token: cus1 });
        const rej = r.data.data.find((o) => o._id === o2);
        check('the customer sees the reason on their orders', rej.status === 'rejected' && rej.statusReason.code === 'sold_out' && rej.statusReason.note === 'Sorry, the goat is finished');
        r = await call('PUT', `/orders/${o2}/status`, { token: chefKeToken, json: { status: 'accepted', readyInMinutes: 20 } });
        check('a declined order cannot be accepted later', r.status === 400, msg(r));

        // pickup details are revealed only after acceptance
        r = await call('POST', '/orders', { token: cus1, json: body({ fulfilment: 'pickup', dropoff: undefined }) });
        const o3 = r.data.data._id;
        await call('PUT', `/orders/${o3}/status`, { token: chefKeToken, json: { status: 'accepted', readyInMinutes: 25 } });
        r = await call('GET', '/orders', { token: cus1 });
        const pk = r.data.data.find((o) => o._id === o3).pickup;
        check('after acceptance a PICKUP customer gets the kitchen address and phone', !!pk && pk.address === 'Ngong Rd 5, Nairobi, Nairobi' && pk.phone === '+254722000111', JSON.stringify(pk));
        r = await call('PUT', `/orders/${o3}/courier`, { token: chefKeToken, json: { service: 'bolt' } });
        check('a pickup order does not use a delivery rider', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o3}/status`, { token: chefKeToken, json: { status: 'cancelled' } });
        check('cancelling an accepted order also needs a reason', r.status === 400, msg(r));
        r = await call('PUT', `/orders/${o3}/status`, { token: chefKeToken, json: { status: 'cancelled', reasonCode: 'too_busy' } });
        check('chef cancels an accepted order with a reason', r.status === 200 && r.data.data.status === 'cancelled', msg(r));

        // customer cancels while pending
        r = await call('POST', '/orders', { token: cus1, json: body() });
        const o4 = r.data.data._id;
        r = await call('PUT', `/orders/${o4}/status`, { token: cus1, json: { status: 'cancelled', reason: 'Changed my mind' } });
        check('the customer cancels a pending order', r.status === 200 && r.data.data.status === 'cancelled' && r.data.data.statusReason.code === 'customer_cancelled', msg(r));
        r = await call('PUT', `/orders/${o4}/status`, { token: chefKeToken, json: { status: 'accepted', readyInMinutes: 20 } });
        check('the chef cannot accept an order the customer cancelled', r.status === 400, msg(r));

        // customer books the rider
        await call('PUT', '/kitchens/me', { token: chefKeToken, json: { courierArrangedBy: 'customer' } });
        r = await call('POST', '/orders', { token: cus1, json: body() });
        const o5 = r.data.data._id;
        check('when the customer books the rider, the order says so', r.data.data.courier.arrangedBy === 'customer', msg(r));
        await call('PUT', `/orders/${o5}/status`, { token: chefKeToken, json: { status: 'accepted', readyInMinutes: 30 } });
        r = await call('GET', '/orders', { token: cus1 });
        const own = r.data.data.find((o) => o._id === o5).pickup;
        check('then the customer gets the pickup address and kitchen phone for their own rider', !!own && own.phone === '+254722000111');
        r = await call('PUT', `/orders/${o5}/courier`, { token: chefKeToken, json: { service: 'bolt' } });
        check('the chef cannot fill in the rider when the customer books it (403)', r.status === 403, msg(r));
        r = await call('PUT', `/orders/${o5}/courier`, { token: cus1, json: { service: 'uber', riderName: 'Sam', trackingLink: 'https://m.uber.com/trip/x' } });
        check('the customer records their Uber rider', r.status === 200 && r.data.data.courier.service === 'uber', msg(r));
        r = await call('GET', '/orders', { token: chefKeToken });
        check('the chef sees which rider is coming', r.data.data.find((o) => o._id === o5).courier.riderName === 'Sam');
        await call('PUT', '/kitchens/me', { token: chefKeToken, json: { courierArrangedBy: 'chef' } });

        // fulfilment options and open/closed
        await call('PUT', '/kitchens/me', { token: chefKeToken, json: { fulfilment: { pickup: false, courier: true } } });
        r = await call('POST', '/orders', { token: cus1, json: body({ fulfilment: 'pickup', dropoff: undefined }) });
        check('pickup is refused when the kitchen does not offer it', r.status === 400, msg(r));
        await call('PUT', '/kitchens/me', { token: chefKeToken, json: { fulfilment: { pickup: true, courier: true }, acceptingOrders: false } });
        r = await call('POST', '/orders', { token: cus1, json: body() });
        check('a closed kitchen refuses orders (409)', r.status === 409, msg(r));
        check('a closed kitchen is still listed, marked as not accepting orders', ((await search('country=KE&city=Karen')).find((k) => k.chefId === chefKe) || {}).acceptingOrders === false);
        await call('PUT', '/kitchens/me', { token: chefKeToken, json: { acceptingOrders: true } });
        r = await call('PUT', '/kitchens/me', { token: chefKeToken, json: { enabled: false } });
        r = await call('POST', '/orders', { token: cus1, json: body() });
        check('a disabled kitchen cannot be ordered from (404) and disappears from search', r.status === 404 && !has(await search('country=KE&city=Karen')), msg(r));
        r = await call('GET', `/kitchens/${chefKe}`);
        check('and its kitchen page is gone', r.status === 404, msg(r));
        r = await call('PUT', '/kitchens/me', { token: chefUsToken, json: { enabled: true, name: 'US Kitchen' } });
        check('a chef still needs a phone, address and meals even after being approved', r.status === 400, msg(r));

        section('12. Meal photos');
        const photoForm = (buf, name = 'meal.png', type = 'image/png') => { const f = new FormData(); f.append('photo', new Blob([buf], { type }), name); return f; };
        const bigPng = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 200, g: 80, b: 40 } } }).png().toBuffer();
        const secretJpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } }).jpeg().withExif({ IFD0: { Copyright: 'Secret Home Address' } }).toBuffer();
        const getPhoto = async (url) => { const rr = await fetch(`${BASE.replace(/\/api$/, '')}${url}`); return { status: rr.status, type: rr.headers.get('content-type'), cache: rr.headers.get('cache-control'), buf: Buffer.from(await rr.arrayBuffer()) }; };

        r = await call('PUT', `/meals/${mMain}/photo`, { token: cus1, form: photoForm(bigPng) });
        check('a customer cannot upload meal photos (403)', r.status === 403, msg(r));
        r = await call('PUT', `/meals/${mMain}/photo`, { form: photoForm(bigPng) });
        check('uploading without logging in is refused (401)', r.status === 401, msg(r));
        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefUsToken, form: photoForm(bigPng) });
        check('another chef cannot put a photo on someone else\'s meal (404)', r.status === 404, msg(r));
        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: new FormData() });
        check('an upload with no file is refused', r.status === 400, msg(r));
        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: photoForm(Buffer.from('just some text'), 'notes.txt', 'text/plain') });
        check('a text file is refused', r.status === 400, msg(r));
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: photoForm(svg, 'x.svg', 'image/svg+xml') });
        check('an SVG is refused', r.status === 400, msg(r));
        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: photoForm(svg, 'x.png', 'image/png') });
        check('an SVG renamed to PNG is refused by decoding its real contents', r.status === 400 && /not a valid/i.test(msg(r)), msg(r));
        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: photoForm(Buffer.from('not an image'), 'fake.png', 'image/png') });
        check('invalid image bytes are refused', r.status === 400 && /not a valid/i.test(msg(r)), msg(r));
        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: photoForm(Buffer.alloc(11 * 1024 * 1024), 'huge.jpg', 'image/jpeg') });
        check('a file over 10 MB is refused', r.status === 400 && /too large/i.test(msg(r)), msg(r));

        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: photoForm(bigPng) });
        check('chef can upload a large PNG photo', r.status === 200 && /^\/api\/photos\/meals\/[a-f0-9]{24}\?v=\d+$/.test(r.data.data.photo) && /&size=thumb$/.test(r.data.data.thumb), msg(r));
        const urls1 = r.data.data;
        let ph = await getPhoto(urls1.photo);
        const fullMeta = await sharp(ph.buf).metadata();
        check('public photo is a JPEG resized to 1200px and cacheable', ph.status === 200 && ph.type === 'image/jpeg' && fullMeta.format === 'jpeg' && fullMeta.width === 1200 && /immutable/.test(ph.cache), `${ph.status} ${ph.type} ${fullMeta.width} ${ph.cache}`);
        ph = await getPhoto(urls1.thumb);
        const thumbMeta = await sharp(ph.buf).metadata();
        check('list thumbnail is at most 480px', ph.status === 200 && thumbMeta.width <= 480 && thumbMeta.width > 100, String(thumbMeta.width));

        r = await call('PUT', `/meals/${mSnack}/photo`, { token: chefKeToken, form: photoForm(secretJpeg, 'phone.jpg', 'image/jpeg') });
        check('phone-style photo with metadata is accepted', r.status === 200, msg(r));
        ph = await getPhoto(r.data.data.photo);
        check('stored photo metadata is stripped', !ph.buf.includes(Buffer.from('Secret Home Address')) && !(await sharp(ph.buf).metadata()).exif);

        await call('PUT', '/kitchens/me', { token: chefKeToken, json: { enabled: true } });
        r = await call('GET', `/kitchens/${chefKe}`);
        const mainMeal = r.data.data.meals.find((m) => m.name === 'Nyama Choma Plate');
        const plainMeal = r.data.data.meals.find((m) => m.name.includes('Juice'));
        check('public kitchen menu includes photo links only where photos exist', /^\/api\/photos\/meals\//.test(mainMeal.photo) && mainMeal.thumb && plainMeal.photo === null);
        r = await call('GET', '/kitchens?country=KE&city=Karen');
        const kc = (r.data.data || []).find((k) => k.chefId === chefKe);
        check('kitchen card uses a meal thumbnail as its cover', !!kc && kc.cover === urls1.thumb, JSON.stringify(kc && kc.cover));
        r = await call('GET', '/meals', { token: chefKeToken });
        check('chef meal list includes its photo links', r.data.data.find((m) => m._id === mMain).thumb === urls1.thumb);

        await new Promise((resolve) => setTimeout(resolve, 5));
        r = await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: photoForm(await sharp({ create: { width: 600, height: 600, channels: 3, background: '#00aa55' } }).png().toBuffer()) });
        check('replacing a photo changes its cache URL', r.status === 200 && r.data.data.photo !== urls1.photo, msg(r));
        const urls2 = r.data.data;
        ph = await getPhoto(urls2.photo);
        check('replacement image is served without being enlarged', ph.status === 200 && (await sharp(ph.buf).metadata()).width === 600);
        check('only one stored photo exists per meal', await MealPhoto.countDocuments({ meal: mMain }) === 1);
        r = await call('DELETE', `/meals/${mMain}/photo`, { token: cus1 });
        check('customer cannot remove meal photos (403)', r.status === 403, msg(r));
        r = await call('DELETE', `/meals/${mMain}/photo`, { token: chefKeToken });
        check('chef can remove a meal photo', r.status === 200 && r.data.data.photo === null, msg(r));
        check('removed photo URL returns 404', (await getPhoto(urls2.photo)).status === 404);

        await call('PUT', `/meals/${mMain}/photo`, { token: chefKeToken, form: photoForm(bigPng) });
        r = await call('DELETE', `/meals/${mMain}`, { token: chefKeToken });
        check('deleting a meal also deletes its stored photo', r.status === 200 && await MealPhoto.countDocuments({ meal: mMain }) === 0, msg(r));
        check('unknown photo URL returns 404', (await getPhoto('/api/photos/meals/507f1f77bcf86cd799439011')).status === 404);
        check('malformed photo URL returns 400', (await getPhoto('/api/photos/meals/not-an-id')).status === 400);
    } catch (err) {
        failed++;
        console.error('\nTEST SCRIPT CRASHED:', err);
    } finally {
        section('Cleaning up test data');
        try {
            const users = await User.find({ email: new RegExp(`^smoke-${RUN}-`) }).select('_id');
            const userIds = users.map((u) => u._id);
            const chefs = await Chef.find({ user: { $in: userIds } }).select('_id');
            const chefIds = chefs.map((c) => c._id);
            await Booking.deleteMany({ $or: [{ chef: { $in: chefIds } }, { customer: { $in: userIds } }] });
            await TimeOff.deleteMany({ chef: { $in: chefIds } });
            await Order.deleteMany({ $or: [{ chef: { $in: chefIds } }, { customer: { $in: userIds } }] });
            await MealPhoto.deleteMany({ chef: { $in: chefIds } });
            await Meal.deleteMany({ chef: { $in: chefIds } });
            await ChefApplication.deleteMany({ chef: { $in: chefIds } });
            await Chef.deleteMany({ _id: { $in: chefIds } });
            await User.deleteMany({ _id: { $in: userIds } });
            const dir = path.join(__dirname, '..', 'uploads', 'applications');
            if (fs.existsSync(dir)) {
                fs.readdirSync(dir).filter((f) => userIds.some((id) => f.startsWith(String(id)))).forEach((f) => fs.unlinkSync(path.join(dir, f)));
            }
            console.log(`  removed ${userIds.length} users, ${chefIds.length} chefs and their bookings/files`);
        } catch (e) { console.error('  cleanup problem:', e.message); }
        await mongoose.connection.close();
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(failed ? 1 : 0);
    }
})();
