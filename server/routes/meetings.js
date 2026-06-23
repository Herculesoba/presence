const express = require('express');
const router = express.Router();

// In-memory store for meetings (for demo — replace with Firestore in production)
const meetings = new Map();

function generateMeetingId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// POST /api/meetings - Create a new meeting
router.post('/', (req, res) => {
  try {
    const { hostId, hostName, name, roomType } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Meeting name is required' });
    }

    const id = generateMeetingId();
    const meeting = {
      id,
      name,
      roomType: roomType || 'boardroom',
      hostId: hostId || 'anonymous',
      hostName: hostName || 'Anonymous Host',
      participants: [{ uid: hostId || 'host', name: hostName || 'Host', isHost: true }],
      createdAt: Date.now(),
      status: 'waiting',
      agenda: req.body.agenda || '',
      scheduledAt: req.body.scheduledAt || null
    };

    meetings.set(id, meeting);

    res.json({
      id,
      name,
      roomType,
      hostId,
      hostName,
      link: `presence://meet/${id}`,
      createdAt: meeting.createdAt
    });

  } catch (err) {
    console.error('Create meeting error:', err);
    res.status(500).json({ error: 'Failed to create meeting' });
  }
});

// GET /api/meetings/:id - Get meeting by ID
router.get('/:id', (req, res) => {
  try {
    const meeting = meetings.get(req.params.id.toUpperCase());

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    res.json(meeting);

  } catch (err) {
    console.error('Get meeting error:', err);
    res.status(500).json({ error: 'Failed to get meeting' });
  }
});

// PUT /api/meetings/:id/join - Join a meeting
router.put('/:id/join', (req, res) => {
  try {
    const { uid, name } = req.body;
    const meeting = meetings.get(req.params.id.toUpperCase());

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Add participant if not already in meeting
    const existing = meeting.participants.find(p => p.uid === uid);
    if (!existing) {
      meeting.participants.push({ uid, name, isHost: false });
    }
    meeting.status = 'active';

    res.json({ success: true, participants: meeting.participants });

  } catch (err) {
    console.error('Join meeting error:', err);
    res.status(500).json({ error: 'Failed to join meeting' });
  }
});

// PUT /api/meetings/:id/leave - Leave a meeting
router.put('/:id/leave', (req, res) => {
  try {
    const { uid } = req.body;
    const meeting = meetings.get(req.params.id.toUpperCase());

    if (meeting) {
      meeting.participants = meeting.participants.filter(p => p.uid !== uid);
      if (meeting.participants.length === 0) {
        meeting.status = 'ended';
      }
    }

    res.json({ success: true });

  } catch (err) {
    console.error('Leave meeting error:', err);
    res.status(500).json({ error: 'Failed to leave meeting' });
  }
});

module.exports = router;