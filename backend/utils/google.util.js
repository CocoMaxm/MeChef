const { OAuth2Client } = require('google-auth-library');

let client;

// Checks a Google ID token ("credential") with Google's public keys.
// The library verifies the signature, the expiry, the issuer and that the token was issued
// for OUR Client ID (audience), so a token meant for another website is refused.
const verifyGoogleToken = async (idToken) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!client) client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const p = ticket.getPayload();
    return {
        googleId: p.sub,
        email: p.email,
        emailVerified: p.email_verified === true,
        firstName: p.given_name,
        lastName: p.family_name,
        fullName: p.name
    };
};

module.exports = { verifyGoogleToken };
