const mongoose = require('mongoose');
const { COUNTRIES, DEFAULT_COUNTRY } = require('../config/countries');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const chefSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    bio: { type: String, required: [true, 'Bio is required'], maxlength: [500, 'Bio cannot exceed 500 characters'] },
    experience: { type: Number, required: [true, 'Years of experience is required'], min: [1, 'Minimum 1 year of experience required'] },
    cuisineSpecialization: { 
        type: String, 
        required: [true, 'Cuisine specialization is required'], 
        enum: ['Italian', 'French', 'Asian', 'Mexican', 'Indian', 'Mediterranean', 'American', 'Kenyan','Other'] 
    },
    additionalCuisines: [{ type: String }],
    signatureDishes: [{ type: String, trim: true, maxlength: 80 }],
    hourlyRate: { type: Number, required: [true, 'Hourly rate is required'], min: [1, 'Hourly rate must be greater than 0'] },
    serviceLocation: {
        country: { type: String, enum: Object.keys(COUNTRIES), default: DEFAULT_COUNTRY },
        city: { type: String, required: true },
        state: { type: String, default: "" }, // ✅ now optional, defaults empty string
        maxTravelDistance: { type: Number, default: 25 } // km 
    },
    availability: {
        type: Map,
        of: Boolean,
        default: {
            monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true
        }
    },
    // "Independent kitchen": the chef sells meals for delivery or pickup, not only home visits.
    // phone and pickupAddress are PRIVATE (select: false): they never appear in public queries,
    // and customers only see them for their own accepted orders.
    kitchen: {
        enabled: { type: Boolean, default: false },
        acceptingOrders: { type: Boolean, default: true },               // open / closed switch
        name: { type: String, trim: true, maxlength: 60 },
        tagline: { type: String, trim: true, maxlength: 120 },
        deliveryAreas: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },   // empty = the chef's whole city
        phone: { type: String, select: false },
        pickupAddress: {
            street: { type: String, trim: true, maxlength: 150, select: false },
            city: { type: String, trim: true, maxlength: 80, select: false },
            state: { type: String, trim: true, maxlength: 80, select: false },
            zipCode: { type: String, trim: true, maxlength: 20, select: false }
        },
        fulfilment: {
            pickup: { type: Boolean, default: true },
            courier: { type: Boolean, default: true }                    // a rider from a delivery app collects the food
        },
        courierArrangedBy: { type: String, enum: ['chef', 'customer'], default: 'chef' },
        minOrder: { type: Number, min: 0, default: 0 }
    },
    workingHours: {
        start: { type: String, default: '08:00', match: [TIME_RE, 'Working hours must be HH:MM'] },
        end: { type: String, default: '22:00', match: [TIME_RE, 'Working hours must be HH:MM'] }
    },
    rating: {
        average: { type: Number, default: 0, min: 0, max: 5 },
        count: { type: Number, default: 0 }
    },
    profileImage: { type: String, default: null },
    certifications: [{ name: String, issuer: String, dateObtained: Date }],
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    applicationStatus: { type: String, enum: ['not-submitted', 'submitted', 'interview-scheduled', 'interviewed', 'approved', 'rejected'], default: 'not-submitted' },
    createdAt: { type: Date, default: Date.now }
});

// Create index for location-based queries
chefSchema.index({ 'serviceLocation.city': 1, 'serviceLocation.state': 1 });
chefSchema.index({ cuisineSpecialization: 1 });
chefSchema.index({ 'serviceLocation.country': 1, additionalCuisines: 1 });
chefSchema.index({ 'serviceLocation.country': 1 });
chefSchema.index({ 'kitchen.enabled': 1, 'serviceLocation.country': 1 });
chefSchema.index({ 'rating.average': -1 });

module.exports = mongoose.model('Chef', chefSchema);
