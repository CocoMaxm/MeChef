const Meal = require('../models/Meal.model');
const MealPhoto = require('../models/MealPhoto.model');
const { processMealPhoto } = require('../utils/image.util');
const { photoUrls } = require('../utils/photoUrl.util');
const Chef = require('../models/Chef.model');
const K = require('../config/kitchen');

const MAX_MEALS = 100;
const toBool = (v) => v === true || v === 'true';

// Validates the fields a chef may set. Returns { error } or { data }.
const clean = (b, { partial }) => {
    const data = {};
    const err = (error) => ({ error });
    if (b.name !== undefined || !partial) {
        const v = String(b.name || '').trim();
        if (v.length < 2 || v.length > 80) return err('The meal name must be 2 to 80 characters');
        data.name = v;
    }
    if (b.price !== undefined || !partial) {
        const v = Number(b.price);
        if (!Number.isFinite(v) || v < 1 || v > 10000000) return err('Enter a price greater than 0');
        data.price = v;
    }
    if (b.description !== undefined) { const v = String(b.description).trim(); if (v.length > 300) return err('The description can be at most 300 characters'); data.description = v; }
    if (b.cuisine !== undefined) { if (!K.CUISINES.includes(b.cuisine)) return err('Choose a valid cuisine'); data.cuisine = b.cuisine; }
    if (b.category !== undefined) { if (!K.codes(K.CATEGORIES).includes(b.category)) return err('Choose a valid category'); data.category = b.category; }
    if (b.portion !== undefined) { const v = String(b.portion).trim(); if (v.length > 40) return err('The portion note can be at most 40 characters'); data.portion = v; }
    if (b.prepMinutes !== undefined) { const v = Number(b.prepMinutes); if (!Number.isInteger(v) || v < 5 || v > 240) return err('Preparation time must be 5 to 240 minutes'); data.prepMinutes = v; }
    if (b.dietary !== undefined) {
        if (!Array.isArray(b.dietary) || b.dietary.some((d) => !K.codes(K.DIETARY).includes(d))) return err('Unknown dietary option');
        data.dietary = [...new Set(b.dietary)];
    }
    if (b.isAvailable !== undefined) data.isAvailable = toBool(b.isAvailable);
    return { data };
};

const myChef = (req) => Chef.findOne({ user: req.user.id });
// A meal as the chef's dashboard sees it, with its photo links.
const mealJson = (m) => ({ ...m.toObject(), ...photoUrls(m) });

// @route GET /api/meals  (private, chef) - every meal, including ones switched off
exports.listMine = async (req, res, next) => {
    try {
        const chef = await myChef(req);
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        const data = await Meal.find({ chef: chef._id }).sort({ category: 1, name: 1 });
        res.status(200).json({ success: true, count: data.length, data: data.map(mealJson) });
    } catch (err) { next(err); }
};

// @route POST /api/meals  (private, chef)
exports.createMeal = async (req, res, next) => {
    try {
        const chef = await myChef(req);
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        const { error, data } = clean(req.body, { partial: false });
        if (error) return res.status(400).json({ success: false, error });
        if (await Meal.countDocuments({ chef: chef._id }) >= MAX_MEALS) {
            return res.status(400).json({ success: false, error: `You can list at most ${MAX_MEALS} meals` });
        }
        const meal = await Meal.create({ cuisine: chef.cuisineSpecialization, ...data, chef: chef._id });
        res.status(201).json({ success: true, data: mealJson(meal) });
    } catch (err) { next(err); }
};

// @route PUT /api/meals/:id  (private, chef, own meals only)
exports.updateMeal = async (req, res, next) => {
    try {
        const chef = await myChef(req);
        const meal = chef && await Meal.findOne({ _id: req.params.id, chef: chef._id });
        if (!meal) return res.status(404).json({ success: false, error: 'Meal not found' });
        const { error, data } = clean(req.body, { partial: true });
        if (error) return res.status(400).json({ success: false, error });
        meal.set(data);
        await meal.save();
        res.status(200).json({ success: true, data: mealJson(meal) });
    } catch (err) { next(err); }
};

// @route DELETE /api/meals/:id  (private, chef)
exports.deleteMeal = async (req, res, next) => {
    try {
        const chef = await myChef(req);
        const removed = chef && await Meal.findOneAndDelete({ _id: req.params.id, chef: chef._id });
        if (!removed) return res.status(404).json({ success: false, error: 'Meal not found' });
        await MealPhoto.deleteOne({ meal: removed._id });
        res.status(200).json({ success: true, data: {} });
    } catch (err) { next(err); }
};

// @route PUT /api/meals/:id/photo (private, chef, own meals only)
// Verifies and resizes the photo, removing metadata such as embedded GPS coordinates.
exports.uploadPhoto = async (req, res, next) => {
    try {
        const chef = await myChef(req);
        const meal = chef && await Meal.findOne({ _id: req.params.id, chef: chef._id });
        if (!meal) return res.status(404).json({ success: false, error: 'Meal not found' });
        if (!req.file) return res.status(400).json({ success: false, error: 'Choose a photo to upload' });

        const { data, thumb, width, height } = await processMealPhoto(req.file.buffer);
        await MealPhoto.updateOne(
            { meal: meal._id },
            { $set: { chef: chef._id, data, thumb, width, height, updatedAt: new Date() } },
            { upsert: true }
        );
        meal.photoVersion = Date.now();
        await meal.save();
        res.status(200).json({ success: true, data: mealJson(meal) });
    } catch (err) { next(err); }
};

// @route DELETE /api/meals/:id/photo (private, chef, own meals only)
exports.removePhoto = async (req, res, next) => {
    try {
        const chef = await myChef(req);
        const meal = chef && await Meal.findOne({ _id: req.params.id, chef: chef._id });
        if (!meal) return res.status(404).json({ success: false, error: 'Meal not found' });
        await MealPhoto.deleteOne({ meal: meal._id });
        meal.photoVersion = undefined;
        await meal.save();
        res.status(200).json({ success: true, data: mealJson(meal) });
    } catch (err) { next(err); }
};
