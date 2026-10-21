const express = require('express');
const router = express.Router();
const { getChefs, getChef, getMyProfile, updateChef, getChefAvailability, getChefSlots, listMyTimeOff, addTimeOff, deleteTimeOff } = require('../controllers/chef.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

router.get('/', getChefs);

// '/me' MUST be declared before '/:id', otherwise "me" is treated as an id
router.get('/me', protect, authorize('chef'), getMyProfile);

// Chef's own time off (periods they are not available), set in advance
router.get('/me/time-off', protect, authorize('chef'), listMyTimeOff);
router.post('/me/time-off', protect, authorize('chef'), addTimeOff);
router.delete('/me/time-off/:id', protect, authorize('chef'), deleteTimeOff);

router.get('/:id/availability', getChefAvailability);
router.get('/:id/slots', getChefSlots);

router.route('/:id')
    .get(getChef)
    .put(protect, authorize('chef'), updateChef);

module.exports = router;
