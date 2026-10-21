const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    firstName: { type: String, required: [true, 'First name is required'], trim: true },
    lastName: { type: String, required: [true, 'Last name is required'], trim: true },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please enter a valid email']
    },
    // Accounts created with "Continue with Google" have no password
    password: { type: String, required: [function () { return !this.googleId; }, 'Password is required'], minlength: 6, select: false },
    googleId: { type: String, unique: true, sparse: true },
    emailVerified: { type: Boolean, default: false }, // true once the email is proven (confirmation link, Google sign-in or password-reset link)
    emailVerificationToken: { type: String, select: false },   // hash of the emailed confirmation token
    emailVerificationExpires: { type: Date, select: false },
    // Forgot-password: only a HASH of the emailed token is stored
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    passwordChangedAt: { type: Date, select: false }, // logins issued before this moment stop working
    role: { type: String, enum: ['customer', 'chef', 'admin'], default: 'customer' },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

// Hash password only when it changed (the old hook kept running after next() and re-hashed)
userSchema.pre('save', async function () {
    if (!this.isModified('password') || !this.password) return;
    this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = async function (enteredPassword) {
    if (!this.password) return false; // Google-only account
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
