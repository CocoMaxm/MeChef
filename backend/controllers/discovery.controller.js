const mongoose = require('mongoose');
const Chef = require('../models/Chef.model');
const ChefPost = require('../models/ChefPost.model');
const UserInteraction = require('../models/UserInteraction.model');
const { escapeRegex } = require('../utils/helpers.util');
const cloudinary = require('../utils/cloudinary.util');
const { DIETARY, codes } = require('../config/kitchen');

const list = (value, maxItems = 10, maxLength = 60) => {
    const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return [...new Set(input.map((item) => String(item).trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
};
const validId = (id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;
const publicChef = (query) => query.populate({ path: 'chef', match: { isActive: true, isVerified: true }, select: 'user bio experience cuisineSpecialization additionalCuisines signatureDishes hourlyRate serviceLocation rating profileImage', populate: { path: 'user', select: 'firstName lastName' } });

const addPostSummaries = async (posts, userId) => {
    if (!posts.length) return posts;
    const ids = posts.map((post) => post._id);
    const [counts, mine] = await Promise.all([
        UserInteraction.aggregate([
            { $match: { kind: 'like', targetType: 'post', target: { $in: ids } } },
            { $group: { _id: '$target', count: { $sum: 1 } } }
        ]),
        userId ? UserInteraction.find({ user: userId, targetType: 'post', target: { $in: ids }, kind: { $in: ['like', 'save'] } }).select('kind target').lean() : []
    ]);
    const countMap = new Map(counts.map((row) => [String(row._id), row.count]));
    const liked = new Set(mine.filter((row) => row.kind === 'like').map((row) => String(row.target)));
    const saved = new Set(mine.filter((row) => row.kind === 'save').map((row) => String(row.target)));
    return posts.map((post) => ({ ...post, likeCount: countMap.get(String(post._id)) || 0, likedByMe: liked.has(String(post._id)), savedByMe: saved.has(String(post._id)) }));
};

exports.listPosts = async (req, res, next) => {
    try {
        const { cuisine, dish, location, occasion, dietary, chef: chefId, country, post: postId } = req.query;
        const query = { published: true };
        if (postId) {
            if (!validId(postId)) return res.status(400).json({ success: false, error: 'Choose a valid story.' });
            query._id = postId;
        }
        if (cuisine) query.cuisines = new RegExp(`^${escapeRegex(String(cuisine).slice(0, 60))}$`, 'i');
        if (occasion) query.occasions = new RegExp(`^${escapeRegex(String(occasion).slice(0, 60))}$`, 'i');
        if (dietary) query.dietaryTags = String(dietary).toLowerCase().slice(0, 30);
        if (chefId) {
            if (!validId(chefId)) return res.status(400).json({ success: false, error: 'Choose a valid chef.' });
            query.chef = chefId;
        }
        if (dish) {
            const re = new RegExp(escapeRegex(String(dish).slice(0, 80)), 'i');
            query.$or = [{ dishName: re }, { caption: re }];
        }
        if (location || country) {
            const chefQuery = { isActive: true, isVerified: true };
            if (location) chefQuery['serviceLocation.city'] = new RegExp(escapeRegex(String(location).slice(0, 80)), 'i');
            if (country) chefQuery['serviceLocation.country'] = String(country).toUpperCase().slice(0, 2);
            const matchingChefs = await Chef.find(chefQuery).select('_id').lean();
            if (!matchingChefs.length) return res.json({ success: true, data: [] });
            if (chefId) {
                if (!matchingChefs.some((item) => String(item._id) === chefId)) return res.json({ success: true, data: [] });
                query.chef = chefId;
            } else query.chef = { $in: matchingChefs.map((item) => item._id) };
        }
        const limit = Math.max(1, Math.min(40, Number.parseInt(req.query.limit, 10) || 18));
        const posts = await publicChef(ChefPost.find(query).sort({ createdAt: -1 }).limit(limit)).lean();
        const data = await addPostSummaries(posts.filter((post) => post.chef), req.user && req.user._id);
        res.json({ success: true, data });
    } catch (err) { next(err); }
};

exports.listMyPosts = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user._id }).select('_id');
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found.' });
        const posts = await ChefPost.find({ chef: chef._id }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, data: await addPostSummaries(posts, req.user._id) });
    } catch (err) { next(err); }
};

exports.signUpload = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user._id }).select('_id isVerified isActive');
        if (!chef || !chef.isActive || !chef.isVerified) return res.status(403).json({ success: false, error: 'Only approved, active chefs can publish discovery posts.' });
        const signature = cloudinary.createUploadSignature(chef._id);
        res.json({ success: true, data: signature });
    } catch (err) { next(err); }
};

exports.createPost = async (req, res, next) => {
    let verifiedMedia = [];
    try {
        const chef = await Chef.findOne({ user: req.user._id });
        if (!chef || !chef.isActive || !chef.isVerified) return res.status(403).json({ success: false, error: 'Only approved, active chefs can publish discovery posts.' });
        const { kind, dishName, caption } = req.body;
        if (!['video', 'carousel'].includes(kind)) return res.status(400).json({ success: false, error: 'Choose a video or photo collection.' });
        const incoming = Array.isArray(req.body.media) ? req.body.media : [];
        if (!incoming.length || incoming.length > 6 || (kind === 'video' && incoming.length !== 1)) {
            return res.status(400).json({ success: false, error: kind === 'video' ? 'A video post has one video.' : 'A photo collection needs 1 to 6 photos.' });
        }
        const cuisines = list(req.body.cuisines, 10, 60);
        const chefCuisines = [chef.cuisineSpecialization, ...(chef.additionalCuisines || [])].map((value) => value.toLowerCase());
        const postCuisines = cuisines.length ? cuisines : [chef.cuisineSpecialization];
        if (postCuisines.some((value) => !chefCuisines.includes(value.toLowerCase()))) {
            return res.status(400).json({ success: false, error: 'Post cuisine tags must match your chef profile specialities.' });
        }
        const dietaryTags = list(req.body.dietaryTags, 8, 30).map((tag) => tag.toLowerCase());
        const supportedDietary = new Set(codes(DIETARY));
        if (dietaryTags.some((tag) => !supportedDietary.has(tag))) return res.status(400).json({ success: false, error: 'One of the dietary tags is not supported.' });
        const occasions = list(req.body.occasions, 8, 60);
        const seen = new Set();
        for (const item of incoming) {
            if (!item || seen.has(item.publicId)) throw new Error('Invalid or repeated media reference.');
            seen.add(item.publicId);
            const expectedType = kind === 'video' ? 'video' : 'image';
            if (item.resourceType !== expectedType) throw new Error('The uploaded media type does not match this post.');
            verifiedMedia.push(await cloudinary.verifyDiscoveryAsset({ chefId: chef._id, publicId: item.publicId, resourceType: expectedType }));
        }
        const post = await ChefPost.create({
            chef: chef._id, kind, dishName, caption: String(caption || '').slice(0, 700),
            cuisines: postCuisines, dietaryTags, occasions, media: verifiedMedia
        });
        res.status(201).json({ success: true, data: post });
    } catch (err) {
        if (verifiedMedia.length) await Promise.allSettled(verifiedMedia.map((asset) => cloudinary.deleteDiscoveryAsset(asset)));
        next(err);
    }
};

exports.updatePost = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user._id }).select('_id cuisineSpecialization additionalCuisines');
        const post = await ChefPost.findOne({ _id: req.params.id, chef: chef && chef._id });
        if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
        if (req.body.dishName !== undefined) post.dishName = String(req.body.dishName).trim().slice(0, 100);
        if (req.body.caption !== undefined) post.caption = String(req.body.caption).trim().slice(0, 700);
        if (req.body.cuisines !== undefined) {
            const cuisines = list(req.body.cuisines, 10, 60);
            const known = [chef.cuisineSpecialization, ...(chef.additionalCuisines || [])].map((value) => value.toLowerCase());
            if (cuisines.some((value) => !known.includes(value.toLowerCase()))) return res.status(400).json({ success: false, error: 'Post cuisine tags must match your profile specialities.' });
            post.cuisines = cuisines.length ? cuisines : [chef.cuisineSpecialization];
        }
        if (req.body.dietaryTags !== undefined) {
            const tags = list(req.body.dietaryTags, 8, 30).map((tag) => tag.toLowerCase());
            if (tags.some((tag) => !codes(DIETARY).includes(tag))) return res.status(400).json({ success: false, error: 'One of the dietary tags is not supported.' });
            post.dietaryTags = tags;
        }
        if (req.body.occasions !== undefined) post.occasions = list(req.body.occasions, 8, 60);
        post.updatedAt = new Date();
        await post.save();
        res.json({ success: true, data: post });
    } catch (err) { next(err); }
};

exports.deletePost = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user._id }).select('_id');
        const post = await ChefPost.findOne({ _id: req.params.id, chef: chef && chef._id });
        if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
        await Promise.allSettled(post.media.map((asset) => cloudinary.deleteDiscoveryAsset(asset)));
        await Promise.all([
            post.deleteOne(),
            UserInteraction.deleteMany({ targetType: 'post', target: post._id })
        ]);
        res.json({ success: true, message: 'Post deleted.' });
    } catch (err) { next(err); }
};
