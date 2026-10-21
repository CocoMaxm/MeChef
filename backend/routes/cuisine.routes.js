const express = require('express');
const router = express.Router();
const { getCuisines } = require('../controllers/cuisine.controller');

router.get('/', getCuisines);

module.exports = router;