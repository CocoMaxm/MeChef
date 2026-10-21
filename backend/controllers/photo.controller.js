const MealPhoto = require('../models/MealPhoto.model');

// Mongoose returns a Buffer; a lean read returns a BSON Binary. Normalise both.
const toBuffer = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(x.buffer || x));

// @route GET /api/photos/meals/:id?size=thumb&v=<version>  (public)
exports.getMealPhoto = async (req, res, next) => {
    try {
        const thumb = req.query.size === 'thumb';
        const doc = await MealPhoto.findOne({ meal: req.params.id }).select(thumb ? 'thumb' : 'data').lean();
        if (!doc) return res.status(404).json({ success: false, error: 'Photo not found' });
        const buf = toBuffer(thumb ? doc.thumb : doc.data);
        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': String(buf.length),
            // the URL carries a version number, so each picture can be cached for a year
            'Cache-Control': 'public, max-age=31536000, immutable'
        });
        res.status(200).send(buf);
    } catch (err) {
        next(err);
    }
};
