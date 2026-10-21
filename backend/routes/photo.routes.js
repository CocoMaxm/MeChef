const express = require('express');
const router = express.Router();
const { getMealPhoto } = require('../controllers/photo.controller');

router.get('/meals/:id', getMealPhoto);

module.exports = router;
