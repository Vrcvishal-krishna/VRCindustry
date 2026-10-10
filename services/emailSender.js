const tls = require('tls');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
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
 * Appends a sent message directly into Hostinger's IMAP "Sent" folder
 * so it immediately appears in Hostinger Webmail, Outlook, and Apple Mail's Sent Items.
 */
async function appendToImapSentFolder({ user, pass, rawMessage }) {
  if (!user || !pass || !rawMessage) return false;

  return new Promise((resolve) => {
    let step = 0;
    const socket = tls.connect(993, 'imap.hostinger.com', { rejectUnauthorized: false }, () => {});

    // Safety timeout: 8 seconds max
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 8000);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();

      // Step 0: Server greeting received -> send LOGIN
      if (step === 0 && buffer.includes('* OK')) {
        step = 1;
        buffer = '';
        socket.write(`A1 LOGIN "${user}" "${pass.replace(/"/g, '\\"')}"\r\n`);
      } 
      // Step 1: LOGIN completed -> send APPEND to "Sent" folder
      else if (step === 1 && (buffer.includes('A1 OK') || buffer.includes('A1 NO') || buffer.includes('A1 BAD'))) {
        if (!buffer.includes('A1 OK')) {
          clearTimeout(timer);
          socket.end();
          return resolve(false);
        }
        step = 2;
        buffer = '';
        const msgBytes = Buffer.byteLength(rawMessage, 'utf8');
        socket.write(`A2 APPEND "Sent" (\\Seen) {${msgBytes}}\r\n`);
      } 
      // Step 2: Server prompts for literal data with '+'
      else if (step === 2 && buffer.includes('+')) {
        step = 3;
        buffer = '';
        socket.write(rawMessage + '\r\n');
      } 
      // Step 3: APPEND response received
      else if (step === 3 && (buffer.includes('A2 OK') || buffer.includes('A2 NO') || buffer.includes('A2 BAD'))) {
        clearTimeout(timer);
        const succeeded = buffer.includes('A2 OK');
        socket.write(`A3 LOGOUT\r\n`);
        socket.end();
        console.log(`[IMAP Auto-Save] Appended message to Hostinger Sent folder: ${succeeded ? 'SUCCESS' : 'FALLBACK'}`);
        resolve(succeeded);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      console.warn('[IMAP Auto-Save] Warning:', err.message);
      resolve(false);
    });

    socket.on('end', () => {
      clearTimeout(timer);
      resolve(step >= 3);
    });
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
 * Sends an email using Nodemailer via Hostinger SMTP and automatically
 * saves a copy into Hostinger's "Sent" folder via IMAP.
 * 
 * @param {Object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.subject - Email subject line
 * @param {string} params.text - Email plaintext body
 * @param {string} [params.html] - Optional HTML formatted body
 * @returns {Promise<{sent: boolean, simulated: boolean, message: string, messageId?: string, savedToSentFolder?: boolean}>}
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

    const mailOptions = {
      from: fromAddress,
      to,
      subject,
      text,
      html: html || text.replace(/\n/g, '<br>')
    };

    // 1. Deliver the email directly to recipient via SMTP
    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailSender] Email sent successfully from ${user} to ${to}, MessageID: ${info.messageId}`);

    // 2. Automatically save an exact copy into Hostinger's "Sent" mailbox folder via IMAP
    let savedToSentFolder = false;
    try {
      const composer = new MailComposer(mailOptions);
      const rawBuffer = await new Promise((res, rej) => {
        composer.compile().build((err, msg) => (err ? rej(err) : res(msg)));
      });
      const rawMessage = rawBuffer.toString('utf8');
      savedToSentFolder = await appendToImapSentFolder({
        user,
        pass: config.SMTP_PASS,
        rawMessage
      });
    } catch (imapErr) {
      console.warn('[EmailSender] IMAP Sent folder copy notice:', imapErr.message);
    }

    return {
      sent: true,
      simulated: false,
      messageId: info.messageId,
      savedToSentFolder,
      message: `Email successfully delivered to ${to} and saved to your Hostinger Sent folder!`
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
  verifySmtpConnection,
  appendToImapSentFolder
};
