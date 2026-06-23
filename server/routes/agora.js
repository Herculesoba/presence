const express = require('express');
const router = express.Router();
const { generateAgoraToken } = require('../services/agoraService');

// POST /api/agora/token
// Body: { meetingId: string, uid: number|string }
router.post('/token', async (req, res) => {
  try {
    const { meetingId, uid } = req.body;

    if (!meetingId || !uid) {
      return res.status(400).json({ error: 'meetingId and uid are required' });
    }

    console.log(`📡 Token request for channel=${meetingId}, uid=${uid}`);
    const token = generateAgoraToken(meetingId, uid);

    res.json({
      token,
      appId: process.env.AGORA_APP_ID,
      channelName: meetingId
    });

  } catch (err) {
    console.error('❌ Agora token error:', err.message);
    res.status(500).json({ error: `Failed to generate Agora token: ${err.message}` });
  }
});

module.exports = router;