const axios = require('axios');

async function generateSummary({ transcript, meetingName, roomType, duration, participants }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Anthropic API key not configured');
  }

  const participantList = Array.isArray(participants) ? participants.join(', ') : 'Team members';
  const durationMins = Math.floor((duration || 0) / 60);

  const prompt = `You are the AI Meeting Assistant for PRESENCE, an immersive 3D teleconferencing application.
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        }
      }
    );

    const text = response.data.content[0].text;
    // Extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Could not parse JSON from response');

  } catch (err) {
    console.error('Claude API error:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { generateSummary };