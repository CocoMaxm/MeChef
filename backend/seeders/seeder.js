// Usage (from the backend root):  node seeders/seeder.js        -> add 30 demo chefs (Kenya, Uganda, Tanzania)
//                                 node seeders/seeder.js -d     -> remove demo chefs only
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User.model');
const Chef = require('../models/Chef.model');
const Meal = require('../models/Meal.model');
const MealPhoto = require('../models/MealPhoto.model');
const Order = require('../models/Order.model');

if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
    console.error('Refusing to run in production. Use --force if you really mean it.');
    process.exit(1);
}

const DEMO_EMAIL = /@demo\.com$/;
const cuisines = ['Kenyan', 'Italian', 'French', 'Asian', 'Indian', 'Mediterranean'];

// Demo menus for the food-ordering feature (Kenya only, prices in KES). The first 12 Kenyan demo chefs get an open kitchen.
const MENUS = {
    Kenyan: [['Nyama Choma Plate', 850, 'main', ['halal', 'spicy'], 40], ['Ugali & Sukuma Wiki', 350, 'main', ['vegetarian'], 25], ['Mandazi (6 pieces)', 250, 'snack', ['vegetarian'], 20], ['Fresh Passion Juice', 150, 'drink', ['vegan'], 10]],
    Italian: [['Spaghetti Bolognese', 700, 'main', [], 30], ['Margherita Pizza', 900, 'main', ['vegetarian'], 35], ['Tiramisu', 450, 'dessert', ['vegetarian'], 15]],
    French: [['Coq au Vin', 1200, 'main', [], 60], ['Sweet Crêpes (3)', 500, 'dessert', ['vegetarian'], 20]],
    Asian: [['Chicken Fried Rice', 650, 'main', [], 25], ['Vegetable Spring Rolls (6)', 400, 'starter', ['vegan'], 20]],
    Indian: [['Chicken Biryani', 800, 'main', ['halal', 'spicy'], 45], ['Paneer Tikka Masala', 750, 'main', ['vegetarian'], 35], ['Mango Lassi', 250, 'drink', ['vegetarian'], 5]],
    Mediterranean: [['Chicken Shawarma Plate', 700, 'main', ['halal'], 30], ['Falafel Wrap', 500, 'main', ['vegan'], 20], ['Hummus & Pita', 350, 'starter', ['vegan'], 10]]
};
const NAIROBI_AREAS = ['Westlands', 'Kilimani', 'Lavington', 'Kileleshwa'];

// Rates are in each country's own currency and respect that country's minimum (config/countries.js)
const markets = [
    { country: 'KE', count: 22, rate: [1000, 5000], places: [
        { city: 'Nairobi', state: 'Nairobi' }, { city: 'Mombasa', state: 'Mombasa' }, { city: 'Kisumu', state: 'Kisumu' },
        { city: 'Nakuru', state: 'Nakuru' }, { city: 'Eldoret', state: 'Uasin Gishu' }, { city: 'Nanyuki', state: 'Laikipia' } ] },
    { country: 'UG', count: 4, rate: [30000, 120000], places: [{ city: 'Kampala', state: 'Central' }, { city: 'Entebbe', state: 'Wakiso' }] },
    { country: 'TZ', count: 4, rate: [20000, 90000], places: [{ city: 'Dar es Salaam', state: 'Dar es Salaam' }, { city: 'Arusha', state: 'Arusha' }] }
];

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

const removeDemoData = async () => {
    const ids = (await User.find({ email: DEMO_EMAIL }).select('_id')).map((u) => u._id);
    const chefIds = (await Chef.find({ user: { $in: ids } }).select('_id')).map((c) => c._id);
    await Order.deleteMany({ chef: { $in: chefIds } });
    await MealPhoto.deleteMany({ chef: { $in: chefIds } });
    await Meal.deleteMany({ chef: { $in: chefIds } });
    await Chef.deleteMany({ user: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
};

const seedChefs = async () => {
    await removeDemoData(); // only demo accounts: real chefs are never touched
    let n = 0;
    for (const m of markets) {
        for (let i = 0; i < m.count; i++, n++) {
            // Plain password: the User model hashes it (hashing here too would double-hash it)
            const user = await User.create({
                firstName: `Chef${n + 1}`, lastName: 'Demo', email: `chef${n + 1}@demo.com`, password: 'password123', role: 'chef', emailVerified: true
            });
            const years = rand(5, 19);
            const cuisine = cuisines[n % cuisines.length];
            const place = m.places[rand(0, m.places.length - 1)];
            const withKitchen = m.country === 'KE' && i < 12;
            const chef = await Chef.create({
                user: user._id,
                bio: `Professional chef with ${years} years of experience in ${cuisine} cuisine.`,
                experience: years,
                cuisineSpecialization: cuisine,
                hourlyRate: Math.round(rand(m.rate[0], m.rate[1]) / 100) * 100,
                serviceLocation: { country: m.country, ...place, maxTravelDistance: 25 },
                rating: { average: Math.round((3.5 + Math.random() * 1.5) * 10) / 10, count: rand(0, 49) },
                isVerified: true, isActive: true, applicationStatus: 'approved',
                kitchen: withKitchen ? {
                    enabled: true, acceptingOrders: true, name: `${cuisine} Kitchen by Chef${n + 1}`, tagline: `${cuisine} favourites, cooked fresh to order`,
                    deliveryAreas: place.city === 'Nairobi' ? NAIROBI_AREAS : [], phone: `+25470000${String(n + 1).padStart(4, '0')}`,
                    pickupAddress: { street: `${n + 1} Demo Road`, city: place.city, state: place.state },
                    fulfilment: { pickup: true, courier: true }, courierArrangedBy: i % 2 === 0 ? 'chef' : 'customer', minOrder: 500
                } : undefined
            });
            if (withKitchen) {
                for (const [name, price, category, dietary, prepMinutes] of MENUS[cuisine]) {
                    await Meal.create({ chef: chef._id, name, price, category, dietary, prepMinutes, cuisine, description: `${name}, made fresh by a home chef.` });
                }
            }
        }
    }
    console.log(`Seeded ${n} demo chefs; the first 12 Kenyan chefs have open kitchens with menus (login: chef1@demo.com / password123)`);
};

(async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        if (process.argv[2] === '-d') { await removeDemoData(); console.log('Demo data deleted'); }
        else await seedChefs();
    } catch (err) {
        console.error(err);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close();
    }
})();
