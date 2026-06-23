const express = require('express');
const router = express.Router();
const { generateSummary } = require('../services/claudeService');

// POST /api/ai/summarise
// Body: { transcript: string, meetingName: string, roomType: string, duration: number, participants: string[] }
router.post('/summarise', async (req, res) => {
  try {
    const { transcript, meetingName, roomType, duration, participants } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: 'transcript is required' });
    }

    const summary = await generateSummary({
      transcript,
      meetingName: meetingName || 'PRESENCE Meeting',
      roomType: roomType || 'Boardroom',
      duration: duration || 0,
      participants: participants || []
    });

    res.json(summary);

  } catch (err) {
    console.error('AI summary error:', err);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

module.exports = router;