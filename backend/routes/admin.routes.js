const express = require('express');
const path = require('path');
const fs = require('fs');
const { body } = require('express-validator');
const router = express.Router();

const Chef = require('../models/Chef.model');
const ChefApplication = require('../models/ChefApplication.model');
const validate = require('../middleware/validate.middleware');
const { protect, authorize } = require('../middleware/auth.middleware');
const { UPLOAD_DIR } = require('../middleware/upload.middleware');
const sendEmail = require('../utils/email.util');
const { escapeHtml } = require('../utils/helpers.util');
const { getCountry } = require('../config/countries');

// Everything below is admin-only. (Express 5 forwards errors from async handlers automatically.)
router.use(protect, authorize('admin'));

const fail = (res, status, error) => res.status(status).json({ success: false, error });
const whenText = (date, tz) =>
    `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(date)} (${tz})`;

// GET /api/admin/pending-chefs - chefs waiting for a decision, with application + interview details
router.get('/pending-chefs', async (req, res) => {
    const chefs = await Chef.find({ isVerified: false, applicationStatus: { $ne: 'rejected' } })
        .populate('user', 'firstName lastName email')
        .lean();

    const apps = await ChefApplication.find({ chef: { $in: chefs.map((c) => c._id) } }).lean();
    const byChef = new Map(apps.map((a) => [a.chef.toString(), a]));

    const data = chefs.map((c) => ({ ...c, application: byChef.get(c._id.toString()) || null }));
    res.json({ success: true, count: data.length, data });
});

// GET /api/admin/chefs/:id/documents/:type  (type = passportPhoto | certificate)
router.get('/chefs/:id/documents/:type', async (req, res) => {
    const { id, type } = req.params;
    if (!['passportPhoto', 'certificate'].includes(type)) return fail(res, 400, 'Invalid document type');
    const application = await ChefApplication.findOne({ chef: id });
    const filename = application && application[type];
    if (!filename) return fail(res, 404, 'Document not found');

    const filePath = path.join(UPLOAD_DIR, path.basename(filename)); // basename blocks path traversal
    if (!fs.existsSync(filePath)) return fail(res, 404, 'File missing on server');
    res.sendFile(filePath);
});

// POST /api/admin/chefs/:id/interview   body: { scheduledAt: ISO date-time, meetingLink?: https url }
// Books (or re-books) the mandatory live interview and emails the chef.
router.post('/chefs/:id/interview', [
    body('scheduledAt').isISO8601().withMessage('A valid interview date and time is required'),
    body('meetingLink').optional({ values: 'falsy' })
        .isURL({ protocols: ['https'], require_protocol: true }).withMessage('The meeting link must be a valid https:// link'),
    validate
], async (req, res) => {
    const chef = await Chef.findById(req.params.id).populate('user');
    if (!chef) return fail(res, 404, 'Chef not found');
    if (chef.isVerified) return fail(res, 400, 'This chef is already approved');

    const application = await ChefApplication.findOne({ chef: chef._id });
    if (!application) return fail(res, 400, 'This chef has not submitted an application yet');
    if (application.interview && application.interview.status === 'completed') {
        return fail(res, 400, 'The interview has already been completed');
    }

    const scheduledAt = new Date(req.body.scheduledAt);
    if (scheduledAt <= new Date()) return fail(res, 400, 'The interview must be scheduled in the future');

    application.set('interview.status', 'scheduled');
    application.set('interview.scheduledAt', scheduledAt);
    application.set('interview.meetingLink', req.body.meetingLink || undefined);
    await application.save();

    chef.applicationStatus = 'interview-scheduled';
    await chef.save();

    const tz = (getCountry(chef.serviceLocation && chef.serviceLocation.country) || getCountry()).timezone;
    const link = req.body.meetingLink
        ? `<p>Join here: <a href="${escapeHtml(req.body.meetingLink)}">${escapeHtml(req.body.meetingLink)}</a></p>`
        : `<p>We will call you on ${escapeHtml(application.phone)}.</p>`;
    await sendEmail.safe({
        email: chef.user.email,
        subject: 'Your MyMealChef live interview',
        html: `<h2>Your live interview is booked</h2><p><strong>${escapeHtml(whenText(scheduledAt, tz))}</strong></p>${link}
               <p>Please have your passport and certificates ready.</p>`
    });

    res.json({ success: true, data: application });
});

// POST /api/admin/chefs/:id/interview/complete   body: { passed: true|false, notes?, reason? }
// Records the result of the live interview. A failed interview rejects the application.
router.post('/chefs/:id/interview/complete', [
    body('passed').isBoolean().withMessage('passed must be true or false').toBoolean(),
    body('notes').optional({ values: 'falsy' }).isString().isLength({ max: 2000 }),
    body('reason').optional({ values: 'falsy' }).isString().isLength({ max: 1000 }),
    validate
], async (req, res) => {
    const { passed, notes, reason } = req.body;

    const chef = await Chef.findById(req.params.id).populate('user');
    if (!chef) return fail(res, 404, 'Chef not found');
    const application = await ChefApplication.findOne({ chef: chef._id });
    if (!application) return fail(res, 400, 'This chef has not submitted an application yet');
    if (application.interview && application.interview.status === 'completed') {
        return fail(res, 400, 'The interview has already been completed');
    }

    application.set('interview.status', 'completed');
    application.set('interview.outcome', passed ? 'passed' : 'failed');
    application.set('interview.notes', notes || undefined);
    application.set('interview.completedAt', new Date());

    if (passed) {
        chef.applicationStatus = 'interviewed';
    } else {
        application.status = 'rejected';
        application.reviewNote = reason;
        application.reviewedAt = new Date();
        chef.isVerified = false;
        chef.applicationStatus = 'rejected';
    }
    await application.save();
    await chef.save();

    if (!passed) {
        await sendEmail.safe({
            email: chef.user.email,
            subject: 'Update on your MyMealChef application',
            html: `<p>Thank you for interviewing with us. Unfortunately we could not approve your application.</p>
                   ${reason ? `<p>${escapeHtml(reason)}</p>` : ''}<p>You can update your details and apply again.</p>`
        });
    }

    res.json({ success: true, message: passed ? 'Interview passed. The chef can now be approved.' : 'Interview failed. The application was rejected.' });
});

// POST /api/admin/verify-chef/:id   body: { status: true|false, reason?: string }
// APPROVING needs a passed live interview. Rejecting is always possible.
router.post('/verify-chef/:id', [
    body('status').isBoolean().withMessage('status must be true or false').toBoolean(),
    body('reason').optional({ values: 'falsy' }).isString().isLength({ max: 1000 }),
    validate
], async (req, res) => {
    const { status, reason } = req.body;

    const chef = await Chef.findById(req.params.id).populate('user');
    if (!chef) return fail(res, 404, 'Chef not found');

    const application = await ChefApplication.findOne({ chef: chef._id });
    if (status && !(application && application.interview && application.interview.outcome === 'passed')) {
        return fail(res, 400, 'A chef can only be approved after a completed live interview that was passed');
    }

    chef.isVerified = status;
    chef.applicationStatus = status ? 'approved' : 'rejected';
    await chef.save();

    if (application) {
        application.status = status ? 'approved' : 'rejected';
        application.reviewNote = reason;
        application.reviewedAt = new Date();
        await application.save();
    }

    await sendEmail.safe(status
        ? {
            email: chef.user.email,
            subject: 'Account Approved!',
            html: '<h1>Congratulations!</h1><p>Your professional profile is now live. You can log in to your dashboard.</p>'
        }
        : {
            email: chef.user.email,
            subject: 'Update on your MyMealChef application',
            html: `<p>Unfortunately we could not approve your application.</p>${reason ? `<p>Reason: ${escapeHtml(reason)}</p>` : ''}<p>You can update your details and apply again.</p>`
        });

    res.json({ success: true, message: status ? 'Chef Approved' : 'Chef Rejected' });
});

module.exports = router;
