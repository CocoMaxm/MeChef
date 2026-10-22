const mongoose = require('mongoose');

const interactionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['like', 'save'], required: true },
    targetType: { type: String, enum: ['chef', 'post', 'meal'], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, default: Date.now }
});

// Enforced by MongoDB as well as the toggle endpoint, so concurrent requests
// cannot create duplicate likes or saves from one customer.
interactionSchema.index({ user: 1, kind: 1, targetType: 1, target: 1 }, { unique: true });
interactionSchema.index({ kind: 1, targetType: 1, target: 1 });

module.exports = mongoose.model('UserInteraction', interactionSchema);
