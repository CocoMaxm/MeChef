const multer = require('multer');

// Meal photos are kept in memory just long enough to be checked and resized (see utils/image.util.js).
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },   // phone photos can be several MB; they are shrunk afterwards
    fileFilter: (req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
        const err = new Error('Only JPG, PNG or WebP photos are allowed');
        err.statusCode = 400;
        cb(err);
    }
});

module.exports = upload.single('photo');
