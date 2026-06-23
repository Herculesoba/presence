require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ── Firebase Admin Init ──────────────────────────────────────
// In production, FIREBASE_SERVICE_ACCOUNT is set in Railway env vars
// as a JSON string. Locally, we fall back to application default credentials.
let firebaseInitialized = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id}.firebaseio.com`
    });
    firebaseInitialized = true;
    console.log('✅ Firebase Admin initialized with service account');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    firebaseInitialized = true;
    console.log('✅ Firebase Admin initialized with Application Default Credentials');
  } else {
    console.warn('⚠️ No Firebase credentials found — auth routes will use mock mode');
  }
} catch (err) {
  console.warn('⚠️ Firebase Admin init error:', err.message);
}

// ── Routes ───────────────────────────────────────────────────
const agoraRoutes = require('./routes/agora');
const aiRoutes = require('./routes/ai');
const meetingsRoutes = require('./routes/meetings');
const authRoutes = require('./routes/auth');

// ── App Setup ────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'PRESENCE API', firebase: firebaseInitialized });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', firebase: firebaseInitialized });
});

// API Routes
app.use('/api/agora', agoraRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/meetings', meetingsRoutes);
app.use('/api/auth', authRoutes);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 PRESENCE server running on port ${PORT}`);
  console.log(`   Firebase: ${firebaseInitialized ? '✅ connected' : '⚠️ not configured'}`);
});