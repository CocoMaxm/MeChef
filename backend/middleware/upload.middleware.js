const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Application documents (passport photo, certificates) are PRIVATE:
// this folder is NOT served statically. Admins fetch them via a protected route.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'applications');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.pdf'];
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) =>
        cb(null, `${req.user.id}-${file.fieldname}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024, files: 2 }, // 5MB each
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXT.includes(ext) && ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
        const err = new Error('Only JPG, PNG or PDF files are allowed');
        err.statusCode = 400;
        cb(err);
    }
});

module.exports = upload;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
