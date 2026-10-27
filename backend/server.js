const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const connectDB = require('./config/db');
const errorHandler = require('./middleware/error.middleware');

// Fail fast on bad configuration instead of misbehaving later
const missing = ['MONGODB_URI', 'JWT_SECRET'].filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}
if (process.env.NODE_ENV === 'production' && /your_super_secret/i.test(process.env.JWT_SECRET)) {
    console.error('❌ JWT_SECRET is still the placeholder value. Set a real secret.');
    process.exit(1);
}

const app = express();

// Render (and most hosts) sit behind a proxy: needed for correct client IPs / rate limiting
app.set('trust proxy', 1);

// 1. Security headers
app.use(helmet({
    // Google's sign-in popup needs this (the default "same-origin" blocks it from talking back to the page)
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://accounts.google.com/gsi/client"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://accounts.google.com/gsi/style"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "http:"],
            mediaSrc: ["'self'", "https://res.cloudinary.com"],
            connectSrc: ["'self'", "http://localhost:5000", "https://mymealchef.onrender.com", "https://cdnjs.cloudflare.com", "https://accounts.google.com/gsi/", "https://api.cloudinary.com"],
            frameSrc: ["'self'", "https://accounts.google.com/gsi/"],
        },
    },
}));

// 2. CORS
const allowedOrigins = process.env.NODE_ENV === 'production'
    ? ['https://mymealchef.onrender.com']
    : ['http://127.0.0.1:5500', 'http://localhost:5500', 'http://localhost:5000'];
app.use(cors({ origin: allowedOrigins, credentials: true }));

// 3. Body parsers (small limit: files go through multer, not JSON)
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// 4. Rate limiting: general + stricter for login/registration (brute-force protection)
//    Strict in production; relaxed in development so repeated testing is not blocked.
//    Override with API_LIMIT_PER_15MIN / LOGIN_LIMIT_PER_15MIN / SIGNUP_LIMIT_PER_HOUR.
const isProd = process.env.NODE_ENV === 'production';
const limitFrom = (envName, prod, dev) => Number(process.env[envName]) || (isProd ? prod : dev);
const limiterOptions = { standardHeaders: 'draft-7', legacyHeaders: false };
app.use('/api', rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, limit: limitFrom('API_LIMIT_PER_15MIN', 300, 5000) }));
app.use(['/api/auth/login', '/api/auth/google'], rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, limit: limitFrom('LOGIN_LIMIT_PER_15MIN', 10, 200),
    message: { success: false, error: 'Too many login attempts, try again in 15 minutes' } }));
app.use(['/api/auth/forgot-password', '/api/auth/reset-password'], rateLimit({ ...limiterOptions, windowMs: 60 * 60 * 1000, limit: limitFrom('RESET_LIMIT_PER_HOUR', 10, 300),
    message: { success: false, error: 'Too many password-reset attempts, try again later' } }));
app.use(['/api/auth/verify-email', '/api/auth/resend-verification'], rateLimit({ ...limiterOptions, windowMs: 60 * 60 * 1000, limit: limitFrom('VERIFY_LIMIT_PER_HOUR', 20, 500),
    message: { success: false, error: 'Too many attempts, try again later' } }));
app.use(['/api/auth/register', '/api/auth/register-chef'], rateLimit({ ...limiterOptions, windowMs: 60 * 60 * 1000, limit: limitFrom('SIGNUP_LIMIT_PER_HOUR', 20, 500),
    message: { success: false, error: 'Too many sign-ups from this address, try again later' } }));

// 5. Routes
app.get('/api/health', (req, res) => res.json({ success: true, status: 'ok' }));
// Public settings the website needs at start-up (the Google Client ID is public by design)
app.get('/api/config', (req, res) => res.json({ success: true, googleClientId: process.env.GOOGLE_CLIENT_ID || null }));
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/chefs', require('./routes/chef.routes'));
app.use('/api/bookings', require('./routes/booking.routes'));
app.use('/api/cuisines', require('./routes/cuisine.routes'));
app.use('/api/countries', require('./routes/country.routes'));
app.use('/api/kitchens', require('./routes/kitchen.routes'));   // food ordering: kitchens (public) + the chef's kitchen settings
app.use('/api/meals', require('./routes/meal.routes'));         // the chef's meals
app.use('/api/orders', require('./routes/order.routes'));       // food orders
app.use('/api/photos', require('./routes/photo.routes'));       // public meal photos (stored in the database)
app.use('/api/discovery', require('./routes/discovery.routes')); // chef cooking posts and signed Cloudinary uploads
app.use('/api/interactions', require('./routes/interaction.routes')); // customer likes and saved collections
app.use('/api/contact', require('./routes/contact.routes'));
app.use('/api/admin', require('./routes/admin.routes'));

// Unknown API routes return JSON instead of the frontend's index.html
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'API route not found' }));

// 6. Serve static frontend (uploads/ is deliberately NOT served: it holds private documents)
const frontendPath = path.join(__dirname, '..', 'Frontend');
app.use(express.static(frontendPath));
app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// 7. Global error handler (MUST BE LAST)
app.use(errorHandler);

// 8. Connect to the database first, then start listening
const PORT = process.env.PORT || 5000;
connectDB().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
});
