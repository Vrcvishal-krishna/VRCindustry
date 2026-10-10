const nodemailer = require('nodemailer');
const config = require('../config');

/**
 * Creates a Nodemailer transporter configured for Hostinger SMTP (or custom env settings)
 */
function createTransporter() {
  const isPort465 = String(config.SMTP_PORT) === '465';
  const isSecure = config.SMTP_SECURE === true || config.SMTP_SECURE === 'true' || isPort465;

  return nodemailer.createTransport({
    host: config.SMTP_HOST || 'smtp.hostinger.com',
    port: parseInt(config.SMTP_PORT, 10) || 465,
    secure: isSecure,
    auth: {
      user: config.SMTP_USER || 'vishal@vrcindustry.com',
      pass: config.SMTP_PASS || ''
    },
    tls: {
      rejectUnauthorized: false
    }
  });
}

/**
 * Verifies Hostinger SMTP connection
 */
async function verifySmtpConnection() {
  if (!config.SMTP_PASS) {
    return {
      success: false,
      message: 'SMTP_PASS is not set. Please provide the password for vishal@vrcindustry.com.'
    };
  }

  try {
    const transporter = createTransporter();
    await transporter.verify();
    return {
      success: true,
      message: `Successfully connected to Hostinger SMTP (${config.SMTP_USER || 'vishal@vrcindustry.com'})`
    };
  } catch (err) {
    return {
      success: false,
      message: `Hostinger SMTP verification error: ${err.message}`
    };
  }
}

/**
 * Sends an email using Nodemailer via Hostinger SMTP.
 * 
 * @param {Object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.subject - Email subject line
 * @param {string} params.text - Email plaintext body
 * @param {string} [params.html] - Optional HTML formatted body
 * @returns {Promise<{sent: boolean, simulated: boolean, message: string, messageId?: string}>}
 */
async function sendApprovedEmail({ to, subject, text, html }) {
  const user = config.SMTP_USER || 'vishal@vrcindustry.com';

  if (!config.SMTP_PASS) {
    console.warn(`[EmailSender] Hostinger email password (SMTP_PASS) is missing for ${user}`);
    return {
      sent: false,
      simulated: true,
      message: `Hostinger email (${user}) is linked, but SMTP_PASS is not set. Set SMTP_PASS in Render Environment or Dashboard Settings to send live.`
    };
  }

  try {
    const transporter = createTransporter();
    const fromAddress = config.EMAIL_FROM || `"Vishal | Time Charge" <${user}>`;

    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject,
      text,
      html: html || text.replace(/\n/g, '<br>')
    });

    console.log(`[EmailSender] Email sent successfully from ${user} to ${to}, MessageID: ${info.messageId}`);
    return {
      sent: true,
      simulated: false,
      messageId: info.messageId,
      message: `Email successfully delivered to ${to} from ${user}`
    };
  } catch (err) {
    console.error(`[EmailSender] Error sending email via Hostinger (${user}) to ${to}:`, err.message);
    let friendlyMessage = err.message;
    if (err.message.includes('535') || err.message.toLowerCase().includes('authentication')) {
      friendlyMessage = `Hostinger authentication failed for ${user}. Please verify your mailbox password in Render or Dashboard Settings.`;
    }
    throw new Error(friendlyMessage);
  }
}

module.exports = {
  sendApprovedEmail,
  verifySmtpConnection
};
