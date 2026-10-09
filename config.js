require('dotenv').config();

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  APOLLO_API_KEY: process.env.APOLLO_API_KEY || '',
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || '',
  SMARTLEAD_API_KEY: process.env.SMARTLEAD_API_KEY || '',
  PORT: process.env.PORT || 3000,
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: process.env.SMTP_PORT || '587',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_SECURE: process.env.SMTP_SECURE || 'false',
  EMAIL_FROM: process.env.EMAIL_FROM || ''
};
