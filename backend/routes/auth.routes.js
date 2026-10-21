const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate.middleware');
const upload = require('../middleware/upload.middleware');
const { protect, authorize, requireVerifiedEmail } = require('../middleware/auth.middleware');
const { register, login, registerChef, getMe, submitInterview, getMyApplication, googleAuth, forgotPassword, resetPassword, verifyEmail, resendVerification } = require('../controllers/auth.controller');
const User = require('../models/User.model');
const { COUNTRIES, DEFAULT_COUNTRY, getCountry } = require('../config/countries');
const { formatMoney } = require('../utils/money.util');

const CUISINES = ['Italian', 'French', 'Asian', 'Mexican', 'Indian', 'Mediterranean', 'American', 'Kenyan', 'Other'];

const checkEmailUnique = async (email) => {
    const user = await User.findOne({ email });
    if (user) throw new Error('Email is already in use');
};

// Sanitise first (trim + lowercase) so "Max@Mail.com" and "max@mail.com" are the same account
const emailField = () => body('email').trim().toLowerCase().isEmail().withMessage('Valid email required');

router.post('/register', [
    body('firstName').trim().notEmpty().withMessage('First name is required'),
    body('lastName').trim().notEmpty().withMessage('Last name is required'),
    emailField().bail().custom(checkEmailUnique),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    validate
], register);

// Google sign-in: the token is verified on the server (see utils/google.util.js)
router.post('/google', googleAuth);

router.post('/login', [
    emailField(),
    body('password').notEmpty().withMessage('Password is required'),
    validate
], login);

router.post('/register-chef', [
    body('firstName').trim().notEmpty().withMessage('First name is required'),
    body('lastName').trim().notEmpty().withMessage('Last name is required'),
    emailField().bail().custom(checkEmailUnique),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('bio').trim().notEmpty().isLength({ max: 500 }).withMessage('Bio is required (max 500 characters)'),
    body('experience').isInt({ min: 1 }).withMessage('Years of experience must be at least 1'),
    body('cuisineSpecialization').isIn(CUISINES).withMessage('Choose a valid cuisine specialization'),
    body('serviceLocation.country').optional().trim().toUpperCase()
        .isIn(Object.keys(COUNTRIES)).withMessage('Unsupported country'),
    body('hourlyRate').custom((value, { req }) => {
        // minimum rate depends on the chef's country, in that country's currency
        const country = getCountry(req.body.serviceLocation && req.body.serviceLocation.country) || COUNTRIES[DEFAULT_COUNTRY];
        const rate = Number(value);
        if (!Number.isFinite(rate) || rate < country.minHourlyRate) {
            throw new Error(`Hourly rate must be at least ${formatMoney(country.minHourlyRate, country)} in ${country.name}`);
        }
        return true;
    }),
    body('serviceLocation.city').trim().notEmpty().withMessage('City is required'),
    validate
], registerChef);

router.post('/forgot-password', [emailField(), validate], forgotPassword);

router.post('/reset-password', [
    body('token').isString().isLength({ min: 64, max: 64 }).withMessage('This reset link is invalid or has expired. Please request a new one.'),
    body('password').isString().isLength({ min: 6, max: 128 }).withMessage('Password must be at least 6 characters'),
    validate
], resetPassword);

router.post('/verify-email', [
    body('token').isString().isLength({ min: 64, max: 64 }).withMessage('This confirmation link is invalid or has expired.'),
    validate
], verifyEmail);
router.post('/resend-verification', protect, resendVerification);

router.get('/me', protect, getMe);
router.get('/my-application', protect, authorize('chef'), getMyApplication);

// Step 2 of chef onboarding: interview answers + documents (chef must be logged in)
router.post('/submit-application',
    protect,
    authorize('chef'),
    requireVerifiedEmail, // before the upload, so nothing is stored for an unconfirmed email
    upload.fields([
        { name: 'passportPhoto', maxCount: 1 },
        { name: 'certificate', maxCount: 1 }
    ]),
    submitInterview
);

module.exports = router;
