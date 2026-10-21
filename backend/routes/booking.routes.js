const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate.middleware');
const { createBooking, getMyBookings, updateBookingStatus, addReview } = require('../controllers/booking.controller');
const { protect, authorize, requireVerifiedEmail } = require('../middleware/auth.middleware');
const { REASONS } = require('../config/bookingReasons');

// Public: the list of reasons a chef can choose when declining a booking
router.get('/reason-codes', (req, res) => res.json({ success: true, data: REASONS }));

router.route('/')
    .get(protect, getMyBookings)
    .post(protect, authorize('customer'), requireVerifiedEmail, [
        body('chefId').notEmpty().withMessage('Chef ID is required'),
        body('date').isISO8601().withMessage('Valid date is required'),
        body('startTime').matches(/^([01]\d|2[0-3]):[0-5]\d$/).withMessage('Start time must be HH:MM (24-hour)'),
        body('duration').isInt({ min: 2, max: 8 }).withMessage('Duration must be between 2-8 hours'),
        body('numberOfGuests').isInt({ min: 1, max: 50 }).withMessage('Number of guests must be between 1-50'),
        body('address.street').trim().notEmpty().withMessage('Street address is required'),
        body('address.city').trim().notEmpty().withMessage('City is required'),
        // state / postal code / country rules depend on the chef's country: checked in the controller
        validate
    ], createBooking);

router.put('/:id/status', protect, authorize('chef'), [
    body('status').isIn(['confirmed', 'rejected', 'cancelled', 'completed']).withMessage('Invalid status'),
    // declining or cancelling needs a reason code; the free-text note is optional ("Other" needs none)
    body('reasonCode').if(body('status').isIn(['rejected', 'cancelled']))
        .isIn(REASONS.map((r) => r.code)).withMessage('Please choose a reason'),
    body('reason').optional({ values: 'falsy' }).isString().isLength({ max: 300 }).withMessage('The note can be at most 300 characters'),
    validate
], updateBookingStatus);

router.post('/:id/review', protect, authorize('customer'), [
    body('score').isInt({ min: 1, max: 5 }).withMessage('Score must be between 1-5'),
    body('review').trim().notEmpty().withMessage('Review is required'),
    validate
], addReview);

module.exports = router;
