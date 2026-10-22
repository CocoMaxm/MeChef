const mongoose = require('mongoose');

const mediaSchema = new mongoose.Schema({
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ['image', 'video'], required: true },
    secureUrl: { type: String, required: true },
    format: { type: String, required: true },
    bytes: { type: Number, required: true },
    duration: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    version: { type: Number, required: true }
}, { _id: false });

const chefPostSchema = new mongoose.Schema({
    chef: { type: mongoose.Schema.Types.ObjectId, ref: 'Chef', required: true, index: true },
    kind: { type: String, enum: ['video', 'carousel'], required: true },
    dishName: { type: String, trim: true, required: true, minlength: 2, maxlength: 100 },
    caption: { type: String, trim: true, maxlength: 700, default: '' },
    cuisines: [{ type: String, trim: true, maxlength: 60 }],
    dietaryTags: [{ type: String, trim: true, lowercase: true, maxlength: 30 }],
    occasions: [{ type: String, trim: true, maxlength: 60 }],
    media: { type: [mediaSchema], validate: [(items) => items.length >= 1 && items.length <= 6, 'A post needs 1 to 6 media items'] },
    published: { type: Boolean, default: true, index: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

chefPostSchema.index({ published: 1, cuisines: 1, createdAt: -1 });
chefPostSchema.index({ chef: 1, published: 1, createdAt: -1 });

module.exports = mongoose.model('ChefPost', chefPostSchema);
