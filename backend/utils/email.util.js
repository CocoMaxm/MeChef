const nodemailer = require('nodemailer');

let transporter;
const getTransporter = () => {
    if (!transporter) {
        const port = Number(process.env.EMAIL_PORT) || 587;
        transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port,
            secure: port === 465,
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
    }
    return transporter;
};

const sendEmail = async (options) => {
    await getTransporter().sendMail({
        from: process.env.EMAIL_FROM,
        to: options.email,
        subject: options.subject,
        html: options.html
    });
};

// Never throws: use this for notifications so a mail outage can't break a request.
sendEmail.safe = async (options) => {
    try {
        await sendEmail(options);
        return true;
    } catch (err) {
        console.error(`Email to ${options.email} failed:`, err.message);
        return false;
    }
};

module.exports = sendEmail;
