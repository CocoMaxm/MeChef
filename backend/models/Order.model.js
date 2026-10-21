const mongoose = require('mongoose');
const { codes, COURIER_SERVICES } = require('../config/kitchen');

const orderSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },                         // short reference shown to chef, customer and rider, e.g. CM-7K3Q9
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    chef: { type: mongoose.Schema.Types.ObjectId, ref: 'Chef', required: true },
    country: { type: String, required: true },
    currency: { type: String, required: true },
    // name and price are copied at order time, so later menu changes never alter an existing order
    items: [{
        meal: { type: mongoose.Schema.Types.ObjectId, ref: 'Meal' },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1, max: 20 },
        note: { type: String, maxlength: 200 }
    }],
    subtotal: { type: Number, required: true },
    fulfilment: { type: String, enum: ['delivery', 'pickup'], required: true },
    customerPhone: { type: String, required: true, match: /^\+[1-9]\d{7,14}$/ },
    dropoff: {
        street: String, area: String, city: String, state: String, zipCode: String, country: String,
        instructions: { type: String, maxlength: 200 }
    },
    notes: { type: String, maxlength: 500 },
    status: { type: String, enum: ['pending', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled'], default: 'pending' },
    statusReason: { code: String, note: { type: String, maxlength: 300 }, at: Date },
    readyInMinutes: Number,
    readyAt: Date,
    courier: {
        arrangedBy: { type: String, enum: ['chef', 'customer'] },                 // who books the rider (Bolt, Uber, ...)
        service: { type: String, enum: codes(COURIER_SERVICES) },
        riderName: { type: String, maxlength: 60 },
        riderPhone: { type: String, match: /^\+[1-9]\d{7,14}$/ },
        trackingLink: { type: String, maxlength: 300 },
        updatedAt: Date
    },
    createdAt: { type: Date, default: Date.now }
});

orderSchema.index({ chef: 1, createdAt: -1 });
orderSchema.index({ customer: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
