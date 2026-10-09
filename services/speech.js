const config = require('../config');

/**
 * Transcribes audio buffer using Groq Whisper API
 * @param {Buffer} audioBuffer 
 * @param {string} filename 
 * @returns {Promise<string>}
 */
async function transcribeAudio(audioBuffer, filename = 'voice.ogg') {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  // Create multipart FormData
  const formData = new FormData();
  const mimeType = filename.endsWith('.wav') ? 'audio/wav' : 'audio/ogg';
  const blob = new Blob([audioBuffer], { type: mimeType });
  
  // Groq requires file extension like .ogg or .wav
  formData.append('file', blob, filename.endsWith('.oga') ? 'voice.ogg' : filename);
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'verbose_json');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.GROQ_API_KEY}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq Whisper failed (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  return result.text ? result.text.trim() : '';
}

module.exports = {
  transcribeAudio
};
