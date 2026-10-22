const express = require('express');
const router = express.Router();
const { protect, optionalProtect, authorize } = require('../middleware/auth.middleware');
const { summary, toggle, saved } = require('../controllers/interaction.controller');

router.get('/summary', optionalProtect, summary);
router.get('/saved', protect, authorize('customer'), saved);
router.post('/toggle', protect, authorize('customer'), toggle);

module.exports = router;
