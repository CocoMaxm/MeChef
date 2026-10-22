const mongoose = require('mongoose');
const UserInteraction = require('../models/UserInteraction.model');
const Chef = require('../models/Chef.model');
const ChefPost = require('../models/ChefPost.model');
const Meal = require('../models/Meal.model');

const TYPES = ['chef', 'post', 'meal'];
const KINDS = ['like', 'save'];
const validId = (id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;

const findPublicTarget = async (targetType, targetId) => {
    if (targetType === 'chef') return Chef.findOne({ _id: targetId, isActive: true, isVerified: true }).select('_id');
    if (targetType === 'post') return ChefPost.findOne({ _id: targetId, published: true }).populate({ path: 'chef', match: { isActive: true, isVerified: true }, select: '_id' }).select('_id chef');
    if (targetType === 'meal') return Meal.findById(targetId).populate({ path: 'chef', match: { isActive: true, isVerified: true }, select: '_id' }).select('_id chef');
    return null;
};

exports.summary = async (req, res, next) => {
    try {
        const { targetType } = req.query;
        const ids = String(req.query.targetIds || '').split(',').filter(Boolean);
        if (!TYPES.includes(targetType) || ids.length > 40 || ids.some((id) => !validId(id))) {
            return res.status(400).json({ success: false, error: 'Choose a valid item type and up to 40 item IDs.' });
        }
        if (!ids.length) return res.json({ success: true, data: [] });
        const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
        const [likes, mine] = await Promise.all([
            UserInteraction.aggregate([
                { $match: { kind: 'like', targetType, target: { $in: objectIds } } },
                { $group: { _id: '$target', count: { $sum: 1 } } }
            ]),
            req.user ? UserInteraction.find({ user: req.user._id, targetType, target: { $in: objectIds }, kind: { $in: ['like', 'save'] } }).select('kind target').lean() : []
        ]);
        const counts = new Map(likes.map((x) => [String(x._id), x.count]));
        const liked = new Set(mine.filter((x) => x.kind === 'like').map((x) => String(x.target)));
        const saved = new Set(mine.filter((x) => x.kind === 'save').map((x) => String(x.target)));
        res.json({ success: true, data: ids.map((id) => ({ id, likeCount: counts.get(id) || 0, liked: liked.has(id), saved: saved.has(id) })) });
    } catch (err) { next(err); }
};

exports.toggle = async (req, res, next) => {
    try {
        const { kind, targetType, targetId } = req.body;
        if (!KINDS.includes(kind) || !TYPES.includes(targetType) || !validId(targetId)) {
            return res.status(400).json({ success: false, error: 'Invalid like or save request.' });
        }
        const target = await findPublicTarget(targetType, targetId);
        if (!target || (targetType !== 'chef' && !target.chef)) return res.status(404).json({ success: false, error: 'That item is not available.' });

        const query = { user: req.user._id, kind, targetType, target: targetId };
        const existing = await UserInteraction.findOne(query).select('_id');
        let active;
        if (existing) {
            await UserInteraction.deleteOne({ _id: existing._id });
            active = false;
        } else {
            try { await UserInteraction.create(query); active = true; }
            catch (err) {
                if (err.code !== 11000) throw err;
                active = true;
            }
        }
        const likeCount = kind === 'like'
            ? await UserInteraction.countDocuments({ kind: 'like', targetType, target: targetId })
            : undefined;
        res.json({ success: true, active, kind, targetType, targetId: String(targetId), likeCount });
    } catch (err) { next(err); }
};

exports.saved = async (req, res, next) => {
    try {
        const interactions = await UserInteraction.find({ user: req.user._id, kind: 'save' }).sort({ createdAt: -1 }).lean();
        const chefIds = interactions.filter((x) => x.targetType === 'chef').map((x) => x.target);
        const postIds = interactions.filter((x) => x.targetType === 'post').map((x) => x.target);
        const mealIds = interactions.filter((x) => x.targetType === 'meal').map((x) => x.target);
        const [chefs, posts, meals] = await Promise.all([
            Chef.find({ _id: { $in: chefIds }, isActive: true, isVerified: true }).populate('user', 'firstName lastName').lean(),
            ChefPost.find({ _id: { $in: postIds }, published: true }).populate({ path: 'chef', select: 'user cuisineSpecialization additionalCuisines serviceLocation hourlyRate', populate: { path: 'user', select: 'firstName lastName' } }).lean(),
            Meal.find({ _id: { $in: mealIds } }).populate({ path: 'chef', match: { isActive: true, isVerified: true }, select: 'user cuisineSpecialization serviceLocation hourlyRate', populate: { path: 'user', select: 'firstName lastName' } }).lean()
        ]);
        const savedAt = new Map(interactions.map((x) => [`${x.targetType}:${x.target}`, x.createdAt]));
        const chefItems = chefs.map((item) => ({ item, savedAt: savedAt.get(`chef:${item._id}`) }));
        const dishItems = [
            ...posts.filter((item) => item.chef).map((item) => ({ type: 'post', item, savedAt: savedAt.get(`post:${item._id}`) })),
            ...meals.filter((item) => item.chef).map((item) => ({ type: 'meal', item, savedAt: savedAt.get(`meal:${item._id}`) }))
        ].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
        res.json({ success: true, data: { chefs: chefItems, dishes: dishItems } });
    } catch (err) { next(err); }
};
