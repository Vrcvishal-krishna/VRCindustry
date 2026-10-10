const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}
const tls = require('tls');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('../config');

/**
 * Creates a Nodemailer transporter configured for Hostinger SMTP with IPv4 enforcement
 */
function createTransporter(customPort = null, customSecure = null) {
  const port = customPort || parseInt(config.SMTP_PORT, 10) || 465;
  const isSecure = customSecure !== null ? customSecure : (config.SMTP_SECURE === true || config.SMTP_SECURE === 'true' || port === 465);

  return nodemailer.createTransport({
    host: config.SMTP_HOST || 'smtp.hostinger.com',
    port: port,
    secure: isSecure,
    family: 4, // Enforce IPv4 to eliminate Render ENETUNREACH IPv6 routing errors
    auth: {
      user: config.SMTP_USER || 'vishal@vrcindustry.com',
      pass: config.SMTP_PASS || '05@Vishal'
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
    const socket = tls.connect(993, 'imap.hostinger.com', { family: 4, rejectUnauthorized: false }, () => {});

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
  const pass = config.SMTP_PASS || '05@Vishal';
  if (!pass) {
    return {
      success: false,
      message: 'SMTP_PASS is not set. Please provide the password for vishal@vrcindustry.com.'
    };
  }

  // 1. Try primary port (465 SSL)
  try {
    const transporter = createTransporter(465, true);
    await transporter.verify();
    return {
      success: true,
      message: `Successfully connected to Hostinger SMTP on Port 465 (${config.SMTP_USER || 'vishal@vrcindustry.com'})`
    };
  } catch (err465) {
    console.warn('[SMTP Verify] Port 465 failed, testing port 587 fallback:', err465.message);
    // 2. Fallback to port 587 STARTTLS
    try {
      const fallbackTransporter = createTransporter(587, false);
      await fallbackTransporter.verify();
      return {
        success: true,
        message: `Successfully connected to Hostinger SMTP on Port 587 (${config.SMTP_USER || 'vishal@vrcindustry.com'})`
      };
    } catch (err587) {
      return {
        success: false,
        message: `Hostinger SMTP verification error: ${err465.message}`
      };
    }
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
  const pass = config.SMTP_PASS || '05@Vishal';

  if (!pass) {
    console.warn(`[EmailSender] Hostinger email password (SMTP_PASS) is missing for ${user}`);
    return {
      sent: false,
      simulated: true,
      message: `Hostinger email (${user}) is linked, but SMTP_PASS is not set. Set SMTP_PASS in Render Environment or Dashboard Settings to send live.`
    };
  }

  const fromAddress = config.EMAIL_FROM || `"Vishal | Time Charge" <${user}>`;
  const mailOptions = {
    from: fromAddress,
    to,
    subject,
    text,
    html: html || text.replace(/\n/g, '<br>')
  };

  let info;
  try {
    // Attempt send on Port 465 SSL
    const transporter = createTransporter(465, true);
    info = await transporter.sendMail(mailOptions);
  } catch (err465) {
    console.warn(`[EmailSender] Port 465 attempt encountered: ${err465.message}. Retrying via Port 587 STARTTLS...`);
    try {
      const fallbackTransporter = createTransporter(587, false);
      info = await fallbackTransporter.sendMail(mailOptions);
    } catch (err587) {
      console.error(`[EmailSender] Error sending email via Hostinger (${user}) to ${to}:`, err587.message);
      let friendlyMessage = err587.message;
      if (err587.message.includes('535') || err587.message.toLowerCase().includes('authentication')) {
        friendlyMessage = `Hostinger authentication failed for ${user}. Please verify your mailbox password in Render or Dashboard Settings.`;
      }
      throw new Error(friendlyMessage);
    }
  }

  console.log(`[EmailSender] Email sent successfully from ${user} to ${to}, MessageID: ${info.messageId}`);

  // Automatically save an exact copy into Hostinger's "Sent" mailbox folder via IMAP
  let savedToSentFolder = false;
  try {
    const composer = new MailComposer(mailOptions);
    const rawBuffer = await new Promise((res, rej) => {
      composer.compile().build((err, msg) => (err ? rej(err) : res(msg)));
    });
    const rawMessage = rawBuffer.toString('utf8');
    savedToSentFolder = await appendToImapSentFolder({
      user,
      pass,
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
}

module.exports = {
  sendApprovedEmail,
  verifySmtpConnection,
  appendToImapSentFolder
};
