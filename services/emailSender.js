const nodemailer = require('nodemailer');
const config = require('../config');

/**
 * Sends an email using Nodemailer via configured SMTP.
 * If SMTP credentials are not present, simulates successful approval safely and logs the draft.
 * 
 * @param {Object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.subject - Email subject line
 * @param {string} params.text - Email plaintext body
 * @param {string} [params.html] - Optional HTML formatted body
 * @returns {Promise<{sent: boolean, simulated: boolean, message: string, messageId?: string}>}
 */
async function sendApprovedEmail({ to, subject, text, html }) {
  if (!config.SMTP_USER || !config.SMTP_PASS) {
    console.log(`[EmailSender] SMTP credentials not set. Simulated send to ${to}`);
    return {
      sent: false,
      simulated: true,
      message: 'SMTP credentials (SMTP_USER, SMTP_PASS) not configured in environment. Email approved & saved to database.'
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(config.SMTP_PORT, 10) || 587,
      secure: config.SMTP_SECURE === 'true' || config.SMTP_PORT === '465',
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS
      }
    });

    const fromAddress = config.EMAIL_FROM || config.SMTP_USER;

    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject,
      text,
      html: html || text.replace(/\n/g, '<br>')
    });

    console.log(`[EmailSender] Email sent successfully to ${to}, MessageID: ${info.messageId}`);
    return {
      sent: true,
      simulated: false,
      messageId: info.messageId,
      message: `Email successfully delivered to ${to}`
    };
  } catch (err) {
    console.error(`[EmailSender] Error sending email to ${to}:`, err.message);
    throw new Error(`Failed to send email: ${err.message}`);
  }
}

module.exports = { sendApprovedEmail };
