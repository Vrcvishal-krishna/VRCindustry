const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}
require('dotenv').config();

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  APOLLO_API_KEY: process.env.APOLLO_API_KEY || '',
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || '',
  SMARTLEAD_API_KEY: process.env.SMARTLEAD_API_KEY || '',
  PORT: process.env.PORT || 3000,
  // Hostinger SMTP configuration for vishal@vrcindustry.com
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.hostinger.com',
  SMTP_PORT: process.env.SMTP_PORT || '465',
  SMTP_USER: process.env.SMTP_USER || 'vishal@vrcindustry.com',
  SMTP_PASS: process.env.SMTP_PASS || '05@Vishal',
  SMTP_SECURE: process.env.SMTP_SECURE || 'true',
  EMAIL_FROM: process.env.EMAIL_FROM || '"Vishal | Time Charge" <vishal@vrcindustry.com>'
};
