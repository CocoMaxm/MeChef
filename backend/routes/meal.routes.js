const express = require('express');
const router = express.Router();
const { listMine, createMeal, updateMeal, deleteMeal, uploadPhoto, removePhoto } = require('../controllers/meal.controller');
const photoUpload = require('../middleware/photoUpload.middleware');
const { protect, authorize } = require('../middleware/auth.middleware');

router.use(protect, authorize('chef'));
router.route('/').get(listMine).post(createMeal);
router.route('/:id').put(updateMeal).delete(deleteMeal);
// Check login and role before reading the uploaded file into memory.
router.put('/:id/photo', photoUpload, uploadPhoto);
router.delete('/:id/photo', removePhoto);

module.exports = router;
