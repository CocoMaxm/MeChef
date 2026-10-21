const express = require('express');
const router = express.Router();
const { getCountries } = require('../controllers/country.controller');

router.get('/', getCountries);

module.exports = router;
