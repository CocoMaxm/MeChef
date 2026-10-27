const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User.model');
const Chef = require('../models/Chef.model');
const ChefApplication = require('../models/ChefApplication.model');
const sendEmail = require('../utils/email.util');
const { escapeHtml, hashToken, appUrl } = require('../utils/helpers.util');
const { sendVerificationEmail } = require('../utils/verification.util');
const { DEFAULT_COUNTRY } = require('../config/countries');
const google = require('../utils/google.util');

const generateToken = (id) =>
    jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '30d' });

const publicUser = (u) => ({
    id: u._id, firstName: u.firstName, lastName: u.lastName, email: u.email, role: u.role, emailVerified: !!u.emailVerified
});

// @route POST /api/auth/register  (public) - ALWAYS creates a customer.
// Chefs go through /register-chef, admins are created with scripts/createAdmin.js
exports.register = async (req, res, next) => {
    try {
        const { firstName, lastName, email, password } = req.body;
        const user = await User.create({ firstName, lastName, email, password, role: 'customer' });
        await sendVerificationEmail(user); // never throws: a mail outage must not block sign-up
        res.status(201).json({ success: true, token: generateToken(user._id), user: publicUser(user) });
    } catch (err) {
        next(err);
    }
};

// @route POST /api/auth/login
exports.login = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password required' });
        }

        const user = await User.findOne({ email }).select('+password');
        if (user && user.isActive && !user.password && user.googleId) {
            return res.status(401).json({ success: false, error: 'This account signs in with Google. Please use the "Continue with Google" button.' });
        }
        if (!user || !user.isActive || !(await user.comparePassword(password))) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const payload = { success: true, token: generateToken(user._id), user: publicUser(user) };
        if (user.role === 'chef') payload.chef = await Chef.findOne({ user: user._id });
        res.status(200).json(payload);
    } catch (err) {
        next(err);
    }
};

// @route POST /api/auth/register-chef
exports.registerChef = async (req, res, next) => {
    let user;
    try {
        const { firstName, lastName, email, password, bio, experience, cuisineSpecialization, additionalCuisines, signatureDishes, hourlyRate, serviceLocation } = req.body;

        user = await User.create({ firstName, lastName, email, password, role: 'chef' });

        let chef;
        try {
            chef = await Chef.create({
                user: user._id,
                bio, experience, cuisineSpecialization,
                additionalCuisines: Array.isArray(additionalCuisines)
                    ? [...new Set(additionalCuisines.map((name) => String(name).trim().slice(0, 60)).filter(Boolean))].slice(0, 10)
                    : [],
                signatureDishes: Array.isArray(signatureDishes)
                    ? [...new Set(signatureDishes.map((name) => String(name).trim().slice(0, 80)).filter(Boolean))].slice(0, 8)
                    : [],
                hourlyRate,
                serviceLocation: {
                    country: String(serviceLocation?.country || DEFAULT_COUNTRY).toUpperCase(),
                    city: serviceLocation?.city || '',
                    state: serviceLocation?.state || ''
                }
            });
        } catch (chefErr) {
            // Don't leave an orphan user that can never register again
            await User.findByIdAndDelete(user._id);
            throw chefErr;
        }

        await sendVerificationEmail(user, { role: 'chef' });

        res.status(201).json({ success: true, token: generateToken(user._id), user: publicUser(user), chef });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/auth/me  (private) - current user (+ chef profile for chefs)
exports.getMe = async (req, res, next) => {
    try {
        const payload = { success: true, user: publicUser(req.user) };
        if (req.user.role === 'chef') payload.chef = await Chef.findOne({ user: req.user.id });
        res.status(200).json(payload);
    } catch (err) {
        next(err);
    }
};

// @route POST /api/auth/submit-application  (private, chef) - multipart/form-data
// fields: answers (JSON string of [{question, answer}] or an object), files: passportPhoto, certificate
exports.submitInterview = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user.id });
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        if (chef.applicationStatus === 'approved') {
            return res.status(400).json({ success: false, error: 'Your profile is already approved' });
        }

        const passportPhoto = req.files?.passportPhoto?.[0];
        const certificate = req.files?.certificate?.[0];
        if (!passportPhoto) {
            return res.status(400).json({ success: false, error: 'Passport photo is required' });
        }

        // Phone the admin will call for the mandatory live interview
        let phone = String(req.body.phone || '').replace(/[\s\-().]/g, '');
        if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
        if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
            return res.status(400).json({ success: false, error: 'A phone number in international format is required, e.g. +254712345678' });
        }
        const preferredInterviewTimes = String(req.body.preferredInterviewTimes || '').trim().slice(0, 300);

        let answers = req.body.answers;
        if (typeof answers === 'string') {
            try { answers = JSON.parse(answers); } catch (e) { answers = []; }
        }
        if (!Array.isArray(answers)) {
            answers = Object.entries(answers || {}).map(([question, answer]) => ({ question, answer: String(answer) }));
        }

        const update = {
            answers,
            phone,
            preferredInterviewTimes,
            interview: { status: 'pending' }, // a (re)submitted application always starts a fresh interview stage
            passportPhoto: passportPhoto.filename,
            status: 'submitted',
            submittedAt: new Date()
        };
        const unset = { reviewNote: '', reviewedAt: '' };
        if (certificate) update.certificate = certificate.filename;
        else unset.certificate = '';

        await ChefApplication.findOneAndUpdate(
            { chef: chef._id },
            { $set: update, $unset: unset },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );

        chef.applicationStatus = 'submitted';
        await chef.save();

        await sendEmail.safe({
            email: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
            subject: 'New chef application to review',
            html: `<p>${escapeHtml(req.user.firstName)} ${escapeHtml(req.user.lastName)} submitted an application. Open the admin panel to review it.</p>`
        });

        res.status(200).json({ success: true, message: 'Application submitted. We will review it shortly.' });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/auth/my-application  (private, chef)
// The chef's own application progress. Admin-only notes are never returned.
exports.getMyApplication = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user.id });
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        const app = await ChefApplication.findOne({ chef: chef._id }).lean();

        res.status(200).json({
            success: true,
            data: {
                applicationStatus: chef.applicationStatus,
                isVerified: chef.isVerified,
                submittedAt: app ? app.submittedAt : null,
                phone: app ? app.phone : null,
                preferredInterviewTimes: app ? app.preferredInterviewTimes : null,
                interview: app && app.interview
                    ? { status: app.interview.status, scheduledAt: app.interview.scheduledAt, meetingLink: app.interview.meetingLink }
                    : null,
                reviewNote: chef.applicationStatus === 'rejected' && app ? app.reviewNote : null
            }
        });
    } catch (err) {
        next(err);
    }
};

// ---------------------------------------------------------------------------
// Google sign-in / sign-up
// ---------------------------------------------------------------------------
const namesFrom = (p) => {
    let first = (p.firstName || '').trim();
    let last = (p.lastName || '').trim();
    if (!first && p.fullName) {
        const parts = p.fullName.trim().split(/\s+/);
        first = parts.shift();
        last = last || parts.join(' ');
    }
    return { first: first || p.email.split('@')[0], last: last || '-' };
};

// @route POST /api/auth/google   body: { credential, password? }   (public)
//  - known Google account            -> log in
//  - new email                       -> create a CUSTOMER account (chefs apply through the chef sign-up form)
//  - email already has a password
//    account that Google never verified -> the person must enter that account's password once to link it
//    (stops someone who pre-registered your email from keeping access after you "sign in with Google")
exports.googleAuth = async (req, res, next) => {
    try {
        if (!process.env.GOOGLE_CLIENT_ID) {
            return res.status(503).json({ success: false, error: 'Google sign-in is not set up on this server yet' });
        }
        const { credential, password } = req.body;
        if (typeof credential !== 'string' || credential.length < 20 || credential.length > 4096) {
            return res.status(400).json({ success: false, error: 'Google sign-in credential is missing' });
        }

        let profile;
        try {
            profile = await google.verifyGoogleToken(credential);
        } catch (e) {
            return res.status(401).json({ success: false, error: 'Google sign-in failed. Please try again.' });
        }
        if (!profile.emailVerified || !profile.email) {
            return res.status(401).json({ success: false, error: 'Your Google email address is not verified' });
        }
        const email = String(profile.email).toLowerCase();

        let user = await User.findOne({ googleId: profile.googleId });
        let isNew = false;

        if (!user) {
            const existing = await User.findOne({ email }).select('+password');
            if (existing) {
                if (existing.googleId && existing.googleId !== profile.googleId) {
                    return res.status(409).json({ success: false, error: 'That email is already linked to a different Google account' });
                }
                if (!existing.emailVerified) {
                    if (!password) {
                        return res.status(409).json({
                            success: false, code: 'PASSWORD_REQUIRED',
                            error: 'You already have a MyMealChef account with this email. Enter its password once to connect your Google account.'
                        });
                    }
                    if (!(await existing.comparePassword(String(password)))) {
                        return res.status(401).json({ success: false, error: 'That password is not correct for this account' });
                    }
                }
                existing.googleId = profile.googleId;
                existing.emailVerified = true;
                await existing.save();
                user = existing;
            } else {
                const { first, last } = namesFrom({ ...profile, email });
                user = await User.create({ firstName: first, lastName: last, email, googleId: profile.googleId, emailVerified: true, role: 'customer' });
                isNew = true;
            }
        }

        if (!user.isActive) {
            return res.status(401).json({ success: false, error: 'This account has been deactivated' });
        }

        const payload = { success: true, isNew, token: generateToken(user._id), user: publicUser(user) };
        if (user.role === 'chef') payload.chef = await Chef.findOne({ user: user._id });
        res.status(isNew ? 201 : 200).json(payload);
    } catch (err) {
        next(err);
    }
};

// ---------------------------------------------------------------------------
// Forgot password / reset password
// ---------------------------------------------------------------------------
const RESET_MINUTES = 60;

// @route POST /api/auth/forgot-password   body: { email }   (public)
// ALWAYS answers the same way, so nobody can use this form to discover who has an account.
exports.forgotPassword = async (req, res, next) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const user = await User.findOne({ email }).select('+passwordResetExpires');

        if (user && user.isActive) {
            // Do not mail-bomb: ignore a second request made within a minute of the previous one
            const ageMs = user.passwordResetExpires
                ? RESET_MINUTES * 60000 - (user.passwordResetExpires.getTime() - Date.now())
                : Infinity;
            if (ageMs >= 60000) {
                const raw = crypto.randomBytes(32).toString('hex');
                user.passwordResetToken = hashToken(raw);
                user.passwordResetExpires = new Date(Date.now() + RESET_MINUTES * 60000);
                await user.save({ validateBeforeSave: false });

                // The token travels in the #fragment, so it is never sent to servers or logs by the browser
                const link = `${appUrl()}/#reset=${raw}`;
                // not awaited: the response time must not reveal whether the account exists
                sendEmail.safe({
                    email: user.email,
                    subject: 'Reset your MyMealChef password',
                    html: `<h2>Reset your password</h2>
                        <p>Hi ${escapeHtml(user.firstName)}, we received a request to reset the password of your MyMealChef account.</p>
                        <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#ff6b6b;color:#fff;text-decoration:none;border-radius:6px">Choose a new password</a></p>
                        <p>Or copy this link into your browser:<br>${link}</p>
                        <p>The link works once and expires in ${RESET_MINUTES} minutes. If you did not ask for this, ignore this email: your password stays the same.</p>`
                });
            }
        }

        res.status(200).json({ success: true, message: 'If an account exists for that email, we have sent a link to reset the password.' });
    } catch (err) {
        next(err);
    }
};

// @route POST /api/auth/reset-password   body: { token, password }   (public)
// The token is single-use and expires. Success signs the person in with a fresh login and
// signs out every older login (including one an intruder may hold).
exports.resetPassword = async (req, res, next) => {
    try {
        const { token, password } = req.body;
        const invalid = () => res.status(400).json({ success: false, error: 'This reset link is invalid or has expired. Please request a new one.' });

        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return invalid();
        if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }

        const user = await User.findOne({
            passwordResetToken: hashToken(token.toLowerCase()),
            passwordResetExpires: { $gt: new Date() }
        });
        if (!user || !user.isActive) return invalid();

        user.password = password;                 // hashed by the model's pre-save hook
        user.passwordChangedAt = new Date();
        user.passwordResetToken = undefined;      // single use
        user.passwordResetExpires = undefined;
        user.emailVerified = true;                // they just proved they control this mailbox
        await user.save();

        await sendEmail.safe({
            email: user.email,
            subject: 'Your MyMealChef password was changed',
            html: `<p>Hi ${escapeHtml(user.firstName)}, the password of your MyMealChef account was just changed.</p>
                   <p>If this was not you, please reset it again straight away and contact us.</p>`
        });

        const payload = { success: true, token: generateToken(user._id), user: publicUser(user) };
        if (user.role === 'chef') payload.chef = await Chef.findOne({ user: user._id });
        res.status(200).json(payload);
    } catch (err) {
        next(err);
    }
};

// ---------------------------------------------------------------------------
// Email confirmation
// ---------------------------------------------------------------------------
// @route POST /api/auth/verify-email   body: { token }   (public)
// A POST (not a link that acts on GET), so email scanners that open links cannot use it up.
// The token stays valid until it expires, so clicking the link twice still says "confirmed".
exports.verifyEmail = async (req, res, next) => {
    try {
        const { token } = req.body;
        const invalid = () => res.status(400).json({ success: false, error: 'This confirmation link is invalid or has expired. Log in and press "Resend email" to get a new one.' });
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return invalid();

        const user = await User.findOne({
            emailVerificationToken: hashToken(token.toLowerCase()),
            emailVerificationExpires: { $gt: new Date() }
        });
        if (!user || !user.isActive) return invalid();

        if (!user.emailVerified) {
            user.emailVerified = true;
            await user.save({ validateBeforeSave: false });
        }
        res.status(200).json({ success: true, email: user.email, message: 'Your email address is confirmed.' });
    } catch (err) {
        next(err);
    }
};

// @route POST /api/auth/resend-verification  (private)
exports.resendVerification = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id).select('+emailVerificationExpires');
        if (user.emailVerified) {
            return res.status(200).json({ success: true, alreadyVerified: true, message: 'Your email address is already confirmed.' });
        }
        await sendVerificationEmail(user);
        res.status(200).json({ success: true, message: `We sent a confirmation link to ${user.email}. Check your inbox (and spam folder).` });
    } catch (err) {
        next(err);
    }
};
