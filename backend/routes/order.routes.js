const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate.middleware');
const { protect, authorize, requireVerifiedEmail } = require('../middleware/auth.middleware');
const { createOrder, listOrders, updateOrderStatus, setCourier } = require('../controllers/order.controller');
const { ORDER_REASONS } = require('../config/kitchen');

router.get('/reason-codes', (req, res) => res.json({ success: true, data: ORDER_REASONS }));

router.route('/')
    .get(protect, authorize('customer', 'chef'), listOrders)
    .post(protect, authorize('customer'), requireVerifiedEmail, createOrder);

router.put('/:id/status', protect, authorize('customer', 'chef'), [
    body('status').isIn(['accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled']).withMessage('Invalid status'),
    validate
], updateOrderStatus);

router.put('/:id/courier', protect, authorize('customer', 'chef'), setCourier);

module.exports = router;
