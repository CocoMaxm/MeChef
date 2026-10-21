const express = require('express');
const router = express.Router();
const { meta, listKitchens, getKitchen, getMyKitchen, updateMyKitchen } = require('../controllers/kitchen.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

router.get('/meta', meta);
router.get('/', listKitchens);
// '/me' must come before '/:chefId'
router.get('/me', protect, authorize('chef'), getMyKitchen);
router.put('/me', protect, authorize('chef'), updateMyKitchen);
router.get('/:chefId', getKitchen);

module.exports = router;
