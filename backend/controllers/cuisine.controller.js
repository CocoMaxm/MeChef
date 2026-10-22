const Chef = require('../models/Chef.model');
const { getCountry } = require('../config/countries');

// @route GET /api/cuisines?country=KE  (public)
// Prices are only averaged when a country is given, because averaging KES with USD is meaningless.
exports.getCuisines = async (req, res, next) => {
    try {
        const match = { isActive: true, isVerified: true };
        let country = null;
        if (req.query.country) {
            country = getCountry(req.query.country);
            if (!country) return res.status(400).json({ success: false, error: 'Unsupported country' });
            match['serviceLocation.country'] = country.code;
        }

        const cuisines = await Chef.aggregate([
            { $match: match },
            { $project: {
                cuisines: { $setUnion: [
                    [{ $toLower: '$cuisineSpecialization' }],
                    { $map: { input: { $ifNull: ['$additionalCuisines', []] }, as: 'cuisine', in: { $toLower: '$$cuisine' } } }
                ] },
                hourlyRate: 1,
                rating: 1
            } },
            { $unwind: '$cuisines' },
            { $group: { _id: '$cuisines', count: { $sum: 1 }, priceTotal: { $sum: '$hourlyRate' }, ratingTotal: { $sum: '$rating.average' } } },
            { $sort: { count: -1 } }
        ]);

        const data = cuisines.map((c) => ({
            name: c._id,
            chefCount: c.count,
            averagePrice: country ? Math.round(c.priceTotal / c.count) : null,
            currency: country ? country.currency : null,
            averageRating: Math.round((c.ratingTotal / c.count) * 10) / 10
        }));

        res.status(200).json({ success: true, data });
    } catch (err) {
        next(err);
    }
};
