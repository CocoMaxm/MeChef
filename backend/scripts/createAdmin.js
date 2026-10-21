// Create or promote an administrator from a trusted terminal.
// Usage: node scripts/createAdmin.js admin@example.com
// An optional legacy password argument is accepted, but a hidden prompt is preferred:
//   node scripts/createAdmin.js admin@example.com "password" First Last
const path = require('path');
const readline = require('node:readline/promises');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User.model');
let pendingSecretInput = '';
let skipNextLineFeed = false;

const readSecret = (label) => new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
        reject(new Error('Run this command in an interactive terminal so the password can be entered safely.'));
        return;
    }

    let value = '';
    process.stdout.write(label);
    const finish = (error) => {
        input.off('data', onData);
        input.setRawMode(false);
        input.pause();
        process.stdout.write('\n');
        if (error) reject(error);
        else resolve(value);
    };
    const onData = (chunk) => {
        const chars = chunk.toString('utf8');
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            if (skipNextLineFeed && char === '\n') { skipNextLineFeed = false; continue; }
            skipNextLineFeed = false;
            if (char === '\u0003') return finish(new Error('Cancelled.'));
            if (char === '\r' || char === '\n') {
                if (char === '\r') skipNextLineFeed = true;
                pendingSecretInput += chars.slice(i + 1);
                return finish();
            }
            if (char === '\u007f' || char === '\b') {
                if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
                continue;
            }
            if (char >= ' ') { value += char; process.stdout.write('*'); }
        }
    };

    try {
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
        if (pendingSecretInput) {
            const queued = pendingSecretInput;
            pendingSecretInput = '';
            onData(Buffer.from(queued));
        }
    } catch (error) {
        reject(error);
    }
});

const confirmPromotion = async (email) => {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await prompt.question(`Account ${email} already exists. Type PROMOTE to grant it admin access and set a new password: `);
        return answer.trim() === 'PROMOTE';
    } finally {
        prompt.close();
    }
};

const getPassword = async (provided) => {
    let password = provided;
    if (!password) {
        password = await readSecret('New admin password (12-128 characters): ');
        const confirm = await readSecret('Confirm password: ');
        if (password !== confirm) throw new Error('The passwords did not match.');
    }
    if (password.length < 12 || password.length > 128) {
        throw new Error('Admin passwords must be 12 to 128 characters long.');
    }
    return password;
};

const [emailArg, passwordArg, firstName = 'Admin', lastName = 'User'] = process.argv.slice(2);

(async () => {
    if (!emailArg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg.trim())) {
        console.error('Usage: npm run create-admin -- <email>');
        process.exitCode = 1;
        return;
    }
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is missing. Set it in backend/.env for the database where this admin should be created.');
        process.exitCode = 1;
        return;
    }

    let connected = false;
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        connected = true;
        const email = emailArg.trim().toLowerCase();
        const existing = await User.findOne({ email }).select('+password');
        if (existing && !existing.isActive) throw new Error('This account is disabled. Review it in the database before granting admin access.');
        if (existing && !(await confirmPromotion(email))) throw new Error('Admin creation cancelled.');

        const password = await getPassword(passwordArg);
        if (existing) {
            existing.role = 'admin';
            existing.password = password;
            existing.emailVerified = true;
            await existing.save();
            console.log(`Account ${email} is now an admin. Its password was reset.`);
        } else {
            await User.create({
                firstName: firstName.trim() || 'Admin',
                lastName: lastName.trim() || 'User',
                email,
                password,
                role: 'admin',
                emailVerified: true
            });
            console.log(`Admin account ${email} created.`);
        }
        console.log('Sign in through the app login form with this email and password.');
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    } finally {
        if (connected) await mongoose.connection.close();
    }
})();
