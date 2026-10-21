const mongoose = require('mongoose');

const chefApplicationSchema = new mongoose.Schema({
    chef: { type: mongoose.Schema.Types.ObjectId, ref: 'Chef', required: true, unique: true },
    answers: [{
        question: { type: String, maxlength: 300 },
        answer: { type: String, maxlength: 2000 }
    }],
    // Number the admin calls for the mandatory live interview (international format)
    phone: { type: String, required: true, match: [/^\+[1-9]\d{7,14}$/, 'Phone must be in international format, e.g. +254712345678'] },
    preferredInterviewTimes: { type: String, maxlength: 300 },
    interview: {
        status: { type: String, enum: ['pending', 'scheduled', 'completed'], default: 'pending' },
        scheduledAt: Date,
        meetingLink: String,
        outcome: { type: String, enum: ['passed', 'failed'] },
        notes: { type: String, maxlength: 2000 }, // admin-only
        completedAt: Date
    },
    passportPhoto: { type: String, required: true }, // filename only, stored in uploads/applications
    certificate: { type: String },
    status: { type: String, enum: ['submitted', 'approved', 'rejected'], default: 'submitted' },
    reviewNote: { type: String, maxlength: 1000 },
    submittedAt: { type: Date, default: Date.now },
    reviewedAt: Date
});

module.exports = mongoose.model('ChefApplication', chefApplicationSchema);
