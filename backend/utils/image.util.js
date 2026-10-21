const sharp = require('sharp');

const ALLOWED_FORMATS = ['jpeg', 'png', 'webp'];
const MAX_INPUT_PIXELS = 40e6; // refuse "decompression bomb" images

const reject = () => {
    const err = new Error('That file is not a valid JPG, PNG or WebP photo');
    err.statusCode = 400;
    return err;
};

// Turns an uploaded photo into two clean JPEGs:
//  - the file's REAL type is checked by decoding it (a renamed text/SVG file is refused)
//  - EXIF orientation is applied first, then ALL hidden metadata (GPS location, camera, owner) is dropped:
//    phone photos often carry the exact coordinates of the chef's kitchen
//  - resized to at most 1200 px (menu) and 480 px (lists), transparent PNGs get a white background
const processMealPhoto = async (buffer) => {
    let meta;
    try {
        meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    } catch (e) { throw reject(); }
    if (!ALLOWED_FORMATS.includes(meta.format)) throw reject();

    try {
        const base = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).rotate().flatten({ background: '#ffffff' });
        const full = await base.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer({ resolveWithObject: true });
        const thumb = await base.clone().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75, mozjpeg: true }).toBuffer();
        return { data: full.data, thumb, width: full.info.width, height: full.info.height };
    } catch (e) { throw reject(); }
};

module.exports = { processMealPhoto };
