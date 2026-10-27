const crypto = require('crypto');
const sendEmail = require('./email.util');
const { escapeHtml, hashToken, appUrl } = require('./helpers.util');

const VERIFY_HOURS = 24;

// Creates a fresh single-person confirmation link and emails it.
// Returns false when it skipped sending because a link was already sent in the last minute (no mail-bombing).
// `user` must have emailVerificationExpires loaded (select '+emailVerificationExpires') when re-sending.
const sendVerificationEmail = async (user, { role } = {}) => {
    const ageMs = user.emailVerificationExpires
        ? VERIFY_HOURS * 3600000 - (user.emailVerificationExpires.getTime() - Date.now())
        : Infinity;
    if (ageMs < 60000) return false;

    const raw = crypto.randomBytes(32).toString('hex');
    user.emailVerificationToken = hashToken(raw);
    user.emailVerificationExpires = new Date(Date.now() + VERIFY_HOURS * 3600000);
    await user.save({ validateBeforeSave: false });

    // The token sits in the #fragment: browsers never send it to servers or logs
    const link = `${appUrl()}/#verify=${raw}`;
    const next = (role || user.role) === 'chef'
        ? '<p>After confirming, log in and complete your application: your documents and a short live interview are needed before your profile goes live.</p>'
        : '<p>Once confirmed you can book chefs.</p>';

    return sendEmail.safe({
        email: user.email,
        subject: 'Confirm your CuisineForMe email address',
        html: `<h2>Confirm your email address</h2>
            <p>Hi ${escapeHtml(user.firstName)}, welcome to CuisineForMe! Please confirm that this is your email address.</p>
            <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#ff6b6b;color:#fff;text-decoration:none;border-radius:6px">Confirm my email</a></p>
            <p>Or copy this link into your browser:<br>${link}</p>
            ${next}
            <p>The link is valid for ${VERIFY_HOURS} hours. If you did not create an account, you can ignore this email.</p>`
    });
};

module.exports = { sendVerificationEmail, VERIFY_HOURS };
