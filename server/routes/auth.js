const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

// POST /api/auth/verify-token
// Body: { idToken: string } — Firebase ID token from client
router.post('/verify-token', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const email = decodedToken.email;
    const name = decodedToken.name || email.split('@')[0];

    // Check if user is admin (you can expand this logic)
    const adminEmails = ['presenceadmin@gmail.com', 'admin@presence.app']; // configure these
    const isAdmin = adminEmails.includes(email);

    res.json({
      uid,
      email,
      name,
      isAdmin,
      displayName: decodedToken.display_name || name
    });

  } catch (err) {
    console.error('Token verification error:', err);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// GET /api/auth/admin-check
// Quick check if a user is admin
router.get('/admin-check/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const adminEmails = ['presenceadmin@gmail.com', 'admin@presence.app'];
    res.json({ isAdmin: adminEmails.includes(email) });
  } catch (err) {
    res.json({ isAdmin: false });
  }
});

module.exports = router;