const Contact = require('../models/Contact.model');
const sendEmail = require('../utils/email.util');
const { escapeHtml } = require('../utils/helpers.util');

// @route POST /api/contact  (public)
exports.submitContact = async (req, res, next) => {
    try {
        const { name, email, subject, message } = req.body;

        await Contact.create({ name, email, subject, message });

        // The message is saved; emails are best-effort and user input is escaped
        await Promise.all([
            sendEmail.safe({
                email: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
                subject: `New Contact Form Submission - ${String(subject).replace(/[\r\n]/g, ' ')}`,
                html: `
                    <h2>New Contact Form Submission</h2>
                    <p><strong>Name:</strong> ${escapeHtml(name)}</p>
                    <p><strong>Email:</strong> ${escapeHtml(email)}</p>
                    <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
                    <p><strong>Message:</strong></p>
                    <p>${escapeHtml(message)}</p>`
            }),
            sendEmail.safe({
                email,
                subject: 'We received your message',
                html: `
                    <h2>Thank you for contacting ChefMtaani!</h2>
                    <p>We've received your message and will get back to you within 24-48 hours.</p>`
            })
        ]);

        res.status(201).json({ success: true, message: 'Your message has been sent successfully' });
    } catch (err) {
        next(err);
    }
};
