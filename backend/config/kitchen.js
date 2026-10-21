// Shared lists for the food-ordering feature (the website reads them from GET /api/kitchens/meta)
const CUISINES = ['Italian', 'French', 'Asian', 'Mexican', 'Indian', 'Mediterranean', 'American', 'Kenyan', 'Other'];
const CATEGORIES = [
    { code: 'starter', label: 'Starters' }, { code: 'main', label: 'Main dishes' }, { code: 'side', label: 'Sides' },
    { code: 'dessert', label: 'Desserts' }, { code: 'drink', label: 'Drinks' }, { code: 'snack', label: 'Snacks' }, { code: 'combo', label: 'Combos' }
];
const DIETARY = [
    { code: 'vegetarian', label: 'Vegetarian' }, { code: 'vegan', label: 'Vegan' }, { code: 'halal', label: 'Halal' },
    { code: 'gluten_free', label: 'Gluten-free' }, { code: 'dairy_free', label: 'Dairy-free' }, { code: 'nut_free', label: 'Nut-free' }, { code: 'spicy', label: 'Spicy' }
];
// Delivery apps the order can be handed to. They are NOT integrated: the chef or the customer books the rider in that app
// and records the details here so both sides can follow the delivery.
const COURIER_SERVICES = [
    { code: 'bolt', label: 'Bolt' }, { code: 'uber', label: 'Uber' }, { code: 'glovo', label: 'Glovo' },
    { code: 'little', label: 'Little' }, { code: 'other', label: 'Other delivery service' }
];
// Reasons a chef can give when declining or cancelling a food order
const ORDER_REASONS = [
    { code: 'sold_out', label: 'An item is sold out' },
    { code: 'too_busy', label: 'I am too busy right now' },
    { code: 'outside_area', label: 'The delivery address is outside my area' },
    { code: 'cannot_prepare', label: 'I cannot prepare this request' },
    { code: 'closed', label: 'The kitchen is closed' },
    { code: 'other', label: 'Other' }
];
const codes = (list) => list.map((x) => x.code);
module.exports = { CUISINES, CATEGORIES, DIETARY, COURIER_SERVICES, ORDER_REASONS, codes };
