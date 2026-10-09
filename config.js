require('dotenv').config();

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  APOLLO_API_KEY: process.env.APOLLO_API_KEY || '',
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || '',
  SMARTLEAD_API_KEY: process.env.SMARTLEAD_API_KEY || '',
  PORT: process.env.PORT || 3000
};
