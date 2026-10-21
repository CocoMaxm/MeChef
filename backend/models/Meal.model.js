const mongoose = require('mongoose');
const { CUISINES, CATEGORIES, DIETARY, codes } = require('../config/kitchen');

// A dish a chef offers for delivery or pickup. Prices are in the currency of the chef's country.
const mealSchema = new mongoose.Schema({
    chef: { type: mongoose.Schema.Types.ObjectId, ref: 'Chef', required: true, index: true },
    name: { type: String, required: [true, 'Meal name is required'], trim: true, minlength: [2, 'Meal name is too short'], maxlength: [80, 'Meal name is too long'] },
    description: { type: String, trim: true, maxlength: [300, 'Description can be at most 300 characters'], default: '' },
    cuisine: { type: String, enum: CUISINES, required: true },
    category: { type: String, enum: codes(CATEGORIES), default: 'main' },
    price: { type: Number, required: [true, 'Price is required'], min: [1, 'Price must be greater than 0'], max: 10000000 },
    portion: { type: String, trim: true, maxlength: 40, default: '' },          // e.g. "Serves 2"
    prepMinutes: { type: Number, min: 5, max: 240, default: 30 },
    dietary: [{ type: String, enum: codes(DIETARY) }],
    photoVersion: { type: Number },                                              // set while the meal has a photo (see MealPhoto)
    isAvailable: { type: Boolean, default: true },                               // the chef's "sold out" switch
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Meal', mealSchema);
