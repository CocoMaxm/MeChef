const { COUNTRIES, DEFAULT_COUNTRY } = require('../config/countries');

// @route GET /api/countries  (public) - drives the country picker and the country-specific form labels
exports.getCountries = (req, res) => {
    res.status(200).json({
        success: true,
        default: DEFAULT_COUNTRY,
        data: Object.values(COUNTRIES)
    });
};
