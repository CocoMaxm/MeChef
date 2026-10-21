const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate.middleware');
const { submitContact } = require('../controllers/contact.controller');

router.post('/', [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('subject').isIn(['booking', 'complaint', 'feedback', 'other']).withMessage('Invalid subject'),
    body('message').notEmpty().withMessage('Message is required'),
    validate
], submitContact);

module.exports = router;