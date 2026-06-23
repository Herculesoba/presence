const axios = require('axios');

async function generateSummary({ transcript, meetingName, roomType, duration, participants }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Anthropic API key not configured');
  }

  const participantList = Array.isArray(participants) ? participants.join(', ') : 'Team members';
  const durationMins = Math.floor((duration || 0) / 60);

  const userMessage = `You are the AI Meeting Assistant for PRESENCE, an immersive 3D teleconferencing application.
Given the following meeting transcript, generate a structured JSON summary.

Meeting Details:
- Name: ${meetingName}
- Room Type: ${roomType}
- Duration: ${durationMins} minutes
- Participants: ${participantList}

Transcript:
${transcript.substring(0, 12000)}

Respond ONLY with a valid JSON object in this exact format (no markdown, no backticks, no extra text):
{
  "topics": ["topic 1", "topic 2", "topic 3"],
  "decisions": ["decision 1", "decision 2"],
  "actions": [
    {"owner": "Person Name", "task": "Description of the task"},
    {"owner": "Person Name", "task": "Another task"}
  ]
}`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: userMessage
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        timeout: 30000
      }
    );

    const rawText = response.data.content?.[0]?.text || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    console.error('Claude response text:', rawText.substring(0, 200));
    throw new Error('Could not parse JSON from Claude response');

  } catch (err) {
    const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Claude API error:', errMsg);
    throw new Error(`Claude API call failed: ${errMsg}`);
  }
}

module.exports = { generateSummary };