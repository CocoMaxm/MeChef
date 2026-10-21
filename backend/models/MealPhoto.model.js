const mongoose = require('mongoose');

// A meal's photo, kept in the database (not on the server's disk): hosts such as Render wipe the disk on every deploy,
// the database survives. One small JPEG for the menu (full) and one for lists (thumb), both already resized.
// Stored in its own collection so normal meal queries never load the image bytes.
const mealPhotoSchema = new mongoose.Schema({
    meal: { type: mongoose.Schema.Types.ObjectId, ref: 'Meal', required: true, unique: true },
    chef: { type: mongoose.Schema.Types.ObjectId, ref: 'Chef', required: true, index: true },
    data: { type: Buffer, required: true },
    thumb: { type: Buffer, required: true },
    width: Number,
    height: Number,
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('MealPhoto', mealPhotoSchema);
