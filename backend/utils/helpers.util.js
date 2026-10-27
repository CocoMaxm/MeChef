const crypto = require('crypto');

// Escape user input before putting it into HTML emails
const escapeHtml = (value = '') =>
    String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

// Escape user input before building a RegExp (prevents regex injection / ReDoS)
const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Emailed tokens are stored only as a SHA-256 hash, so a database leak does not expose working links
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// Public address of the website, used for links in emails
const appUrl = () => String(process.env.APP_URL
    || (process.env.NODE_ENV === 'production' ? 'https://mymealchef.onrender.com' : `http://localhost:${process.env.PORT || 5000}`)).replace(/\/+$/, '');

// "+254 712-345 678" / "00254712345678" -> "+254712345678"; null when it is not a plausible international number
const normalizePhone = (raw) => {
    let p = String(raw || '').replace(/[\s\-().]/g, '');
    if (p.startsWith('00')) p = `+${p.slice(2)}`;
    return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
};

module.exports = { escapeHtml, escapeRegex, hashToken, appUrl, normalizePhone };
