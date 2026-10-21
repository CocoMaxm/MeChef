const Chef = require('../models/Chef.model');
const Meal = require('../models/Meal.model');
const K = require('../config/kitchen');
const { getCountry } = require('../config/countries');
const { normalizePhone } = require('../utils/helpers.util');
const { covers, norm } = require('../utils/kitchen.util');
const { photoUrls } = require('../utils/photoUrl.util');

// The kitchen's private contact details are hidden from normal queries; only the owner (and an accepted order) may read them
const PRIVATE = '+kitchen.phone +kitchen.pickupAddress.street +kitchen.pickupAddress.city +kitchen.pickupAddress.state +kitchen.pickupAddress.zipCode';
const toBool = (v) => v === true || v === 'true';

const publicMeal = (m) => ({
    id: m._id, name: m.name, description: m.description, cuisine: m.cuisine, category: m.category,
    price: m.price, portion: m.portion, prepMinutes: m.prepMinutes, dietary: m.dietary, ...photoUrls(m)
});

const publicKitchen = (chef, meals) => {
    const k = chef.kitchen;
    const prices = meals.map((m) => m.price);
    return {
        chefId: chef._id,
        kitchenName: k.name,
        tagline: k.tagline || '',
        chefName: `${chef.user.firstName} ${chef.user.lastName}`,
        city: chef.serviceLocation.city,
        country: chef.serviceLocation.country,
        currency: (getCountry(chef.serviceLocation.country) || getCountry()).currency,
        deliveryAreas: k.deliveryAreas || [],
        acceptingOrders: k.acceptingOrders !== false,
        minOrder: k.minOrder || 0,
        fulfilment: { pickup: !k.fulfilment || k.fulfilment.pickup !== false, courier: !k.fulfilment || k.fulfilment.courier !== false },
        courierArrangedBy: k.courierArrangedBy || 'chef',
        rating: chef.rating,
        cuisines: [...new Set([chef.cuisineSpecialization, ...meals.map((m) => m.cuisine)])],
        // Prefer a main-dish photo for the kitchen card, then any available meal photo.
        cover: photoUrls(meals.find((m) => m.photoVersion && m.category === 'main') || meals.find((m) => m.photoVersion)).thumb || null,
        mealCount: meals.length,
        priceFrom: prices.length ? Math.min(...prices) : 0,
        priceTo: prices.length ? Math.max(...prices) : 0
    };
};

// @route GET /api/kitchens/meta  (public) - lists the website needs for its forms
exports.meta = (req, res) => {
    res.json({ success: true, data: { cuisines: K.CUISINES, categories: K.CATEGORIES, dietary: K.DIETARY, courierServices: K.COURIER_SERVICES, orderReasons: K.ORDER_REASONS } });
};

// @route GET /api/kitchens?country=KE&city=&area=&cuisine=&dietary=  (public)
exports.listKitchens = async (req, res, next) => {
    try {
        const { country, city, area, cuisine, dietary } = req.query;
        const query = { isActive: true, isVerified: true, 'kitchen.enabled': true };
        if (country) {
            const c = getCountry(country);
            if (!c) return res.status(400).json({ success: false, error: 'Unsupported country' });
            query['serviceLocation.country'] = c.code;
        }
        if (dietary && !K.codes(K.DIETARY).includes(String(dietary))) {
            return res.status(400).json({ success: false, error: 'Unknown dietary option' });
        }

        const chefs = await Chef.find(query).populate('user', 'firstName lastName').limit(300).lean();
        const meals = await Meal.find({ chef: { $in: chefs.map((c) => c._id) }, isAvailable: true }).lean();
        const byChef = new Map();
        meals.forEach((m) => { const k = String(m.chef); if (!byChef.has(k)) byChef.set(k, []); byChef.get(k).push(m); });

        const data = chefs
            .map((chef) => ({ chef, meals: byChef.get(String(chef._id)) || [] }))
            .filter(({ chef, meals: ms }) => ms.length
                && covers(chef, city, area)
                && (!cuisine || norm(chef.cuisineSpecialization) === norm(cuisine) || ms.some((m) => norm(m.cuisine) === norm(cuisine)))
                && (!dietary || ms.some((m) => (m.dietary || []).includes(dietary))))
            .map(({ chef, meals: ms }) => publicKitchen(chef, ms))
            .sort((a, b) => (b.acceptingOrders - a.acceptingOrders) || ((b.rating.average || 0) - (a.rating.average || 0)));

        res.status(200).json({ success: true, count: data.length, data });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/kitchens/:chefId  (public) - one kitchen with its available meals
exports.getKitchen = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ _id: req.params.chefId, isActive: true, isVerified: true, 'kitchen.enabled': true })
            .populate('user', 'firstName lastName').lean();
        if (!chef) return res.status(404).json({ success: false, error: 'Kitchen not found' });
        const meals = await Meal.find({ chef: chef._id, isAvailable: true }).sort({ category: 1, name: 1 }).lean();
        res.status(200).json({ success: true, data: { ...publicKitchen(chef, meals), meals: meals.map(publicMeal) } });
    } catch (err) {
        next(err);
    }
};

const settingsOf = async (chef) => {
    const k = chef.toObject().kitchen || {};
    return {
        enabled: !!k.enabled, acceptingOrders: k.acceptingOrders !== false, name: k.name || '', tagline: k.tagline || '',
        deliveryAreas: k.deliveryAreas || [], phone: k.phone || '',
        pickupAddress: { street: '', city: '', state: '', zipCode: '', ...(k.pickupAddress || {}) },
        fulfilment: { pickup: !k.fulfilment || k.fulfilment.pickup !== false, courier: !k.fulfilment || k.fulfilment.courier !== false },
        courierArrangedBy: k.courierArrangedBy || 'chef', minOrder: k.minOrder || 0,
        isVerified: chef.isVerified,
        availableMeals: await Meal.countDocuments({ chef: chef._id, isAvailable: true })
    };
};

// @route GET /api/kitchens/me  (private, chef)
exports.getMyKitchen = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user.id }).select(PRIVATE);
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        res.status(200).json({ success: true, data: await settingsOf(chef), country: chef.serviceLocation.country });
    } catch (err) {
        next(err);
    }
};

// @route PUT /api/kitchens/me  (private, chef) - kitchen settings. Opening the kitchen needs everything below to be filled in.
exports.updateMyKitchen = async (req, res, next) => {
    try {
        const chef = await Chef.findOne({ user: req.user.id }).select(PRIVATE);
        if (!chef) return res.status(404).json({ success: false, error: 'Chef profile not found' });
        const b = req.body || {};
        const bad = (error) => res.status(400).json({ success: false, error });
        const next_ = await settingsOf(chef);

        if (b.name !== undefined) { const v = String(b.name).trim(); if (v.length > 60) return bad('The kitchen name can be at most 60 characters'); next_.name = v; }
        if (b.tagline !== undefined) { const v = String(b.tagline).trim(); if (v.length > 120) return bad('The tagline can be at most 120 characters'); next_.tagline = v; }
        if (b.deliveryAreas !== undefined) {
            if (!Array.isArray(b.deliveryAreas)) return bad('Delivery areas must be a list');
            const seen = new Set(), areas = [];
            for (const raw of b.deliveryAreas) {
                const v = String(raw).trim();
                if (!v || seen.has(norm(v))) continue;
                if (v.length > 40) return bad('Each delivery area can be at most 40 characters');
                seen.add(norm(v)); areas.push(v);
            }
            if (areas.length > 20) return bad('You can list at most 20 delivery areas');
            next_.deliveryAreas = areas;
        }
        if (b.phone !== undefined) {
            if (String(b.phone).trim() === '') next_.phone = '';
            else { const p = normalizePhone(b.phone); if (!p) return bad('Enter the kitchen phone in international format, e.g. +254712345678'); next_.phone = p; }
        }
        if (b.pickupAddress !== undefined) {
            if (typeof b.pickupAddress !== 'object' || b.pickupAddress === null) return bad('Pickup address is invalid');
            for (const [f, max] of [['street', 150], ['city', 80], ['state', 80], ['zipCode', 20]]) {
                if (b.pickupAddress[f] !== undefined) {
                    const v = String(b.pickupAddress[f]).trim();
                    if (v.length > max) return bad(`Pickup address ${f} is too long`);
                    next_.pickupAddress[f] = v;
                }
            }
        }
        if (b.fulfilment !== undefined && typeof b.fulfilment === 'object' && b.fulfilment) {
            if (b.fulfilment.pickup !== undefined) next_.fulfilment.pickup = toBool(b.fulfilment.pickup);
            if (b.fulfilment.courier !== undefined) next_.fulfilment.courier = toBool(b.fulfilment.courier);
        }
        if (b.courierArrangedBy !== undefined) {
            if (!['chef', 'customer'].includes(b.courierArrangedBy)) return bad('courierArrangedBy must be "chef" or "customer"');
            next_.courierArrangedBy = b.courierArrangedBy;
        }
        if (b.minOrder !== undefined) {
            const v = Number(b.minOrder);
            if (!Number.isFinite(v) || v < 0 || v > 10000000) return bad('The minimum order must be 0 or more');
            next_.minOrder = v;
        }
        if (b.acceptingOrders !== undefined) next_.acceptingOrders = toBool(b.acceptingOrders);
        if (b.enabled !== undefined) next_.enabled = toBool(b.enabled);

        if (next_.enabled) {
            if (!chef.isVerified) return res.status(403).json({ success: false, error: 'Your chef profile must be approved before you can open a kitchen' });
            if (next_.name.length < 2) return bad('Give your kitchen a name');
            if (!next_.phone) return bad('Add a phone number: it is shown to customers once their order is accepted');
            if (!next_.pickupAddress.street || !next_.pickupAddress.city) return bad('Add the address riders or customers collect from (street and city)');
            if (!next_.fulfilment.pickup && !next_.fulfilment.courier) return bad('Offer at least one way to receive orders: pickup or rider delivery');
            if (await Meal.countDocuments({ chef: chef._id, isAvailable: true }) < 1) return bad('Add at least one available meal before opening your kitchen');
        }

        const $set = {
            'kitchen.enabled': next_.enabled, 'kitchen.acceptingOrders': next_.acceptingOrders, 'kitchen.name': next_.name, 'kitchen.tagline': next_.tagline,
            'kitchen.deliveryAreas': next_.deliveryAreas, 'kitchen.phone': next_.phone,
            'kitchen.pickupAddress.street': next_.pickupAddress.street, 'kitchen.pickupAddress.city': next_.pickupAddress.city,
            'kitchen.pickupAddress.state': next_.pickupAddress.state, 'kitchen.pickupAddress.zipCode': next_.pickupAddress.zipCode,
            'kitchen.fulfilment.pickup': next_.fulfilment.pickup, 'kitchen.fulfilment.courier': next_.fulfilment.courier,
            'kitchen.courierArrangedBy': next_.courierArrangedBy, 'kitchen.minOrder': next_.minOrder
        };
        await Chef.updateOne({ _id: chef._id }, { $set }, { runValidators: true });
        const updated = await Chef.findById(chef._id).select(PRIVATE);
        res.status(200).json({ success: true, data: await settingsOf(updated) });
    } catch (err) {
        next(err);
    }
};

exports.PRIVATE_KITCHEN_FIELDS = PRIVATE;
