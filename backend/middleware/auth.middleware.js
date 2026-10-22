const jwt = require('jsonwebtoken');
const User = require('../models/User.model');

const unauthorized = (res) =>
    res.status(401).json({ success: false, error: 'Not authorized to access this route' });

exports.protect = async (req, res, next) => {
    const header = req.headers.authorization;
    const token = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
    if (!token) return unauthorized(res);

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('+passwordChangedAt');
        // Deleted or deactivated accounts must not keep working tokens
        if (!user || !user.isActive) return unauthorized(res);
        // A password reset signs everyone else out: older tokens (e.g. held by someone who knew the old password) stop working
        if (user.passwordChangedAt && decoded.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) return unauthorized(res);
        req.user = user;
        next();
    } catch (err) {
        return unauthorized(res);
    }
};

// Public discovery routes can add personalized like/save state when a valid
// customer token is present, without making sign-in mandatory for browsing.
exports.optionalProtect = async (req, res, next) => {
    const header = req.headers.authorization;
    const token = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
    if (!token) return next();
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('+passwordChangedAt');
        if (user && user.isActive && (!user.passwordChangedAt || decoded.iat >= Math.floor(user.passwordChangedAt.getTime() / 1000))) req.user = user;
    } catch (err) { /* public request stays public if an optional token is stale */ }
    next();
};

exports.authorize = (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            error: `User role ${req.user ? req.user.role : 'unknown'} is not authorized to access this route`
        });
    }
    next();
};

// Some actions (booking a chef, applying as a chef) need a confirmed email address
exports.requireVerifiedEmail = (req, res, next) => {
    if (!req.user.emailVerified) {
        return res.status(403).json({
            success: false, code: 'EMAIL_NOT_VERIFIED',
            error: 'Please confirm your email address first. We sent you a link: check your inbox (and spam folder).'
        });
    }
    next();
};
