const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    subject: { type: String, required: true, enum: ['booking', 'complaint', 'feedback', 'other'] },
    message: { type: String, required: true },
    status: { type: String, enum: ['new', 'in-progress', 'resolved'], default: 'new' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Contact', contactSchema);