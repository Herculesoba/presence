import * as THREE from 'three';
import AgoraRTC from 'agora-rtc-sdk-ng';
import {
  auth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  googleProvider,
  signOut,
  createUserProfile,
  getUserProfile,
  joinMeeting,
  leaveMeeting
} from './firebase/config.js';

// ── GLOBAL STATE ─────────────────────────────────────────────
let currentUser = null;
let currentUserProfile = null;
let meetingCode = '';
let meetingName = '';
let roomType = 'boardroom';
let meetingTimer = 0;
let timerInterval = null;
let muted = false;
let renderer = null;

// ── AGORA + SPATIAL AUDIO STATE ─────────────────────────────
let agoraClient = null;
let localAudioTrack = null;
let spatialAudioManager = null;
let remoteUsers = new Map(); // uid -> { audioTrack, panner, position, name }
let userPosition = { x: 0, y: 1, z: 4 }; // Local user avatar position
let broadcastInterval = null;
let otherAvatars = []; // 3D avatar objects for remote users

// ── SERVER API ───────────────────────────────────────────────
const API_BASE = 'https://presence-production-ad5a.up.railway.app';

async function apiAgoraToken(meetingId, uid) {
  const res = await fetch(`${API_BASE}/api/agora/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingId, uid })
  });
  if (!res.ok) throw new Error('Failed to get Agora token');
  return res.json();
}

async function apiSummarise(transcript, meetingName, roomType, duration, participants) {
  const res = await fetch(`${API_BASE}/api/ai/summarise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, meetingName, roomType, duration, participants })
  });
  if (!res.ok) throw new Error('Failed to get summary');
  return res.json();
}

async function apiCreateMeeting(hostUid, hostName, name, roomType) {
  const res = await fetch(`${API_BASE}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostUid, hostName, name, roomType })
  });
  if (!res.ok) throw new Error('Failed to create meeting');
  return res.json();
}

async function apiGetMeeting(id) {
  const res = await fetch(`${API_BASE}/api/meetings/${id}`);
  if (!res.ok) throw new Error('Meeting not found');
  return res.json();
}

async function apiJoinMeeting(id, uid, name) {
  await fetch(`${API_BASE}/api/meetings/${id}/join`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, name })
  });
}

async function apiLeaveMeeting(id, uid) {
  await fetch(`${API_BASE}/api/meetings/${id}/leave`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid })
  });
}

// ── SPATIAL AUDIO MANAGER ─────────────────────────────────────
class SpatialAudioManager {
  constructor() {
    this.audioContext = null;
    this.listener = null;
    this.panners = new Map(); // uid -> PannerNode
    this.gainNodes = new Map(); // uid -> GainNode
    this.mediaElements = new Map(); // uid -> MediaElement
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.listener = this.audioContext.listener;

      // Position listener at camera origin (0, 1.6, 0) — our camera height
      if (this.listener.positionX) {
        this.listener.positionX.setValueAtTime(0, this.audioContext.currentTime);
        this.listener.positionY.setValueAtTime(1.6, this.audioContext.currentTime);
        this.listener.positionZ.setValueAtTime(0, this.audioContext.currentTime);
      } else {
        this.listener.setPosition(0, 1.6, 0);
      }

      // Resume audio context (required after user gesture)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.initialized = true;
      console.log('✅ SpatialAudioManager initialized');
    } catch (err) {
      console.error('SpatialAudioManager init error:', err);
    }
  }

  updateListenerPosition(x, y, z) {
    if (!this.listener || !this.initialized) return;
    try {
      if (this.listener.positionX) {
        this.listener.positionX.setValueAtTime(x, this.audioContext.currentTime);
        this.listener.positionY.setValueAtTime(y, this.audioContext.currentTime);
        this.listener.positionZ.setValueAtTime(z, this.audioContext.currentTime);
      } else {
        this.listener.setPosition(x, y, z);
      }
    } catch (err) {
      console.error('Error updating listener position:', err);
    }
  }

  updateListenerOrientation(yaw, pitch) {
    if (!this.listener || !this.initialized) return;
    try {
      // Convert camera yaw/pitch to forward vector
      const forwardX = Math.sin(yaw);
      const forwardY = 0;
      const forwardZ = -Math.cos(yaw);

      if (this.listener.forwardX) {
        this.listener.forwardX.setValueAtTime(forwardX, this.audioContext.currentTime);
        this.listener.forwardY.setValueAtTime(forwardY, this.audioContext.currentTime);
        this.listener.forwardZ.setValueAtTime(forwardZ, this.audioContext.currentTime);
        this.listener.upX.setValueAtTime(0, this.audioContext.currentTime);
        this.listener.upY.setValueAtTime(1, this.audioContext.currentTime);
        this.listener.upZ.setValueAtTime(0, this.audioContext.currentTime);
      }
    } catch (err) {
      console.error('Error updating listener orientation:', err);
    }
  }

  // Add a remote user's audio stream with spatial positioning
  addRemoteAudio(uid, audioTrack) {
    if (!this.initialized || this.panners.has(uid)) return;

    try {
      // Create PannerNode for 3D positioning
      const panner = this.audioContext.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = 50;
      panner.rolloffFactor = 1;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 0;
      panner.coneOuterGain = 0;

      // Initial position — will be updated when avatar moves
      panner.positionX.setValueAtTime(2, this.audioContext.currentTime);
      panner.positionY.setValueAtTime(1, this.audioContext.currentTime);
      panner.positionZ.setValueAtTime(1.5, this.audioContext.currentTime);

      // Create gain node for volume control
      const gainNode = this.audioContext.createGain();
      gainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);

      // Create media element from audio track
      const mediaElement = audioTrack.getMediaElement();
      mediaElement.autoplay = false;

      // Connect: mediaElement -> panner -> gain -> destination
      const source = this.audioContext.createMediaElementSource(mediaElement);
      source.connect(panner);
      panner.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      // Set default orientation (omnidirectional)
      panner.orientationX.setValueAtTime(1, this.audioContext.currentTime);
      panner.orientationY.setValueAtTime(0, this.audioContext.currentTime);
      panner.orientationZ.setValueAtTime(0, this.audioContext.currentTime);

      this.panners.set(uid, panner);
      this.gainNodes.set(uid, gainNode);
      this.mediaElements.set(uid, mediaElement);

      // Play the audio
      mediaElement.play().catch(err => console.warn('Audio autoplay prevented:', err));

      console.log(`✅ Added spatial audio for user ${uid}`);
    } catch (err) {
      console.error(`Error adding spatial audio for ${uid}:`, err);
    }
  }

  // Update a remote user's 3D position based on avatar position in scene
  updateRemotePosition(uid, x, y, z) {
    const panner = this.panners.get(uid);
    if (!panner || !this.initialized) return;
    try {
      const now = this.audioContext.currentTime;
      panner.positionX.linearRampToValueAtTime(x, now + 0.05);
      panner.positionY.linearRampToValueAtTime(y, now + 0.05);
      panner.positionZ.linearRampToValueAtTime(z, now + 0.05);
    } catch (err) {
      console.error('Error updating remote position:', err);
    }
  }

  // Mute/unmute a specific remote user
  setRemoteVolume(uid, volume) {
    const gainNode = this.gainNodes.get(uid);
    if (!gainNode) return;
    try {
      gainNode.gain.setValueAtTime(volume, this.audioContext.currentTime);
    } catch (err) {
      console.error('Error setting remote volume:', err);
    }
  }

  // Remove a remote user
  removeRemoteAudio(uid) {
    try {
      const panner = this.panners.get(uid);
      const gainNode = this.gainNodes.get(uid);
      const mediaElement = this.mediaElements.get(uid);

      if (panner) {
        panner.disconnect();
        this.panners.delete(uid);
      }
      if (gainNode) {
        gainNode.disconnect();
        this.gainNodes.delete(uid);
      }
      if (mediaElement) {
        mediaElement.pause();
        this.mediaElements.delete(uid);
      }
    } catch (err) {
      console.error('Error removing remote audio:', err);
    }
  }

  destroy() {
    try {
      if (this.audioContext) {
        this.audioContext.close();
      }
      this.panners.clear();
      this.gainNodes.clear();
      this.mediaElements.clear();
      this.initialized = false;
    } catch (err) {
      console.error('Error destroying SpatialAudioManager:', err);
    }
  }
}

// ── AGORA MANAGER ────────────────────────────────────────────
class AgoraManager {
  constructor() {
    this.client = null;
    this.localUid = Math.floor(Math.random() * 999999);
    this.channelName = null;
    this.token = null;
    this.joined = false;
  }

  async joinChannel(channel, token) {
    try {
      this.channelName = channel;
      this.token = token;

      // Create Agora RTC client
      this.client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

      // Set up event handlers
      this.client.on('user-published', async (user, mediaType) => {
        console.log(`📢 User ${user.uid} published ${mediaType}`);
        if (mediaType === 'audio') {
          // Subscribe to the remote audio track
          await this.client.subscribe(user, mediaType);
          console.log(`✅ Subscribed to audio from ${user.uid}`);

          // Add to spatial audio system
          await spatialAudioManager.init();
          spatialAudioManager.addRemoteAudio(user.uid, user.audioTrack);

          // Get initial position from data channel or default
          const pos = remoteUsers.get(user.uid)?.position || { x: 2, y: 1, z: 1.5 };
          spatialAudioManager.updateRemotePosition(user.uid, pos.x, pos.y, pos.z);
        }
      });

      this.client.on('user-unpublished', (user, mediaType) => {
        console.log(`🔇 User ${user.uid} unpublished ${mediaType}`);
        if (mediaType === 'audio') {
          spatialAudioManager.removeRemoteAudio(user.uid);
          remoteUsers.delete(user.uid);
        }
      });

      this.client.on('user-joined', (user) => {
        console.log(`👋 User ${user.uid} joined channel ${this.channelName}`);
        // Initialize remote user entry
        if (!remoteUsers.has(user.uid)) {
          remoteUsers.set(user.uid, { audioTrack: null, position: { x: 2, y: 1, z: 1.5 }, name: `User_${user.uid}` });
        }
      });

      this.client.on('user-left', (user) => {
        console.log(`👋 User ${user.uid} left`);
        spatialAudioManager.removeRemoteAudio(user.uid);
        remoteUsers.delete(user.uid);
      });

      // Join the channel with the token
      await this.client.join('28142cdd0c7140a493243a0bc8bc6062', channel, token, this.localUid);
      console.log(`✅ Joined Agora channel: ${channel} as uid: ${this.localUid}`);

      // Create microphone audio track
      localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: 'music_standard',
        AGC: true,
        ANS: true,
        AEC: true
      });

      // Publish local audio
      await this.client.publish(localAudioTrack);
      console.log('✅ Published local microphone audio');

      // Handle data channel messages for avatar sync
      this.client.on('message', (msg) => {
        this.handleDataMessage(msg);
      });

      // Start broadcasting our position
      this.startPositionBroadcast();

      this.joined = true;
      return true;

    } catch (err) {
      console.error('❌ Agora join error:', err);
      throw err;
    }
  }

  // Send avatar position to all other users via data channel
  broadcastPosition(x, y, z) {
    if (!this.joined || !this.client) return;
    try {
      const msg = JSON.stringify({
        type: 'avatar_position',
        uid: this.localUid,
        name: currentUserProfile?.displayName || currentUser?.email || 'Unknown',
        x, y, z,
        timestamp: Date.now()
      });
      this.client.sendStreamMessage(msg).catch(err => {
        // Data channel may not be enabled — ignore silently
      });
    } catch (err) {
      // Silently ignore — data channel is optional
    }
  }

  // Receive and process data messages
  handleDataMessage(msg) {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'avatar_position' && data.uid !== this.localUid) {
        // Update stored position
        const existing = remoteUsers.get(data.uid) || {};
        remoteUsers.set(data.uid, {
          ...existing,
          position: { x: data.x, y: data.y, z: data.z },
          name: data.name
        });

        // Update spatial audio position
        if (spatialAudioManager.initialized) {
          spatialAudioManager.updateRemotePosition(data.uid, data.x, data.y, data.z);
        }

        // Update 3D avatar position in scene
        this.updateRemoteAvatarMesh(data.uid, data.x, data.y, data.z);
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  // Update a remote user's 3D avatar mesh position in the scene
  updateRemoteAvatarMesh(uid, x, y, z) {
    const avatar = otherAvatars.find(a => a.uid === uid);
    if (avatar && avatar.body) {
      // Smooth interpolation towards target position
      avatar.targetX = x;
      avatar.targetY = y;
      avatar.targetZ = z;
    }
  }

  // Start broadcasting position every ~33ms (~30fps)
  startPositionBroadcast() {
    if (broadcastInterval) clearInterval(broadcastInterval);
    broadcastInterval = setInterval(() => {
      if (this.joined) {
        this.broadcastPosition(userPosition.x, userPosition.y, userPosition.z);
      }
    }, 33);
  }

  // Mute/unmute local microphone
  setMute(mute) {
    if (!localAudioTrack) return;
    try {
      if (mute) {
        localAudioTrack.setEnabled(false);
      } else {
        localAudioTrack.setEnabled(true);
      }
    } catch (err) {
      console.error('Error toggling mute:', err);
    }
  }

  async leaveChannel() {
    try {
      if (broadcastInterval) {
        clearInterval(broadcastInterval);
        broadcastInterval = null;
      }

      if (localAudioTrack) {
        await localAudioTrack.stop();
        await localAudioTrack.close();
        localAudioTrack = null;
      }

      if (this.client && this.joined) {
        await this.client.leave();
        this.joined = false;
        console.log('✅ Left Agora channel');
      }

      this.client = null;

      // Clean up spatial audio
      if (spatialAudioManager) {
        spatialAudioManager.destroy();
        spatialAudioManager = null;
      }
    } catch (err) {
      console.error('Error leaving channel:', err);
    }
  }
}

// ── INIT AGORA + SPATIAL AUDIO ────────────────────────────────
async function initAgoraSession() {
  try {
    // Initialize spatial audio
    spatialAudioManager = new SpatialAudioManager();
    await spatialAudioManager.init();

    // Get Agora token from our server
    const { token, channelName } = await apiAgoraToken(meetingCode, agoraClient?.localUid || Math.floor(Math.random() * 99999));

    // Create Agora manager and join
    agoraClient = new AgoraManager();
    await agoraClient.joinChannel(meetingCode, token);

    return true;
  } catch (err) {
    console.error('Failed to initialize Agora session:', err);
    return false;
  }
}

// ── SCREEN MANAGER ───────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => {
    el.classList.add('fade-out');
    setTimeout(() => {
      el.classList.remove('visible', 'fade-out');
      el.style.display = 'none';
    }, 300);
  });
  document.getElementById('three-canvas').style.display = 'none';
  document.getElementById('meeting-screen').style.display = 'none';

  setTimeout(() => {
    if (id === 'meeting') {
      document.getElementById('three-canvas').style.display = 'block';
      document.getElementById('meeting-screen').style.display = 'flex';
    } else {
      const target = document.getElementById(id);
      if (target) {
        target.style.display = 'flex';
        requestAnimationFrame(() => target.classList.add('visible'));
      }
    }
  }, 300);
}

function showError(id, msg) {
  const el = document.getElementId(id);
  if (el) { el.textContent = msg; el.classList.add('show'); }
  setTimeout(() => { if (el) el.classList.remove('show'); }, 4000);
}

function showLoading(show) {
  const el = document.getElementById('loading-overlay');
  if (el) { if (show) el.classList.add('show'); else el.classList.remove('show'); }
}

// ── AUTH ─────────────────────────────────────────────────────
function initAuth() {
  const signInTab = document.getElementById('tab-signin');
  const signUpTab = document.getElementById('tab-signup');
  const signInForm = document.getElementById('form-signin');
  const signUpForm = document.getElementById('form-signup');

  function switchTab(tab) {
    if (tab === 'signin') {
      signInTab.classList.add('active');
      signUpTab.classList.remove('active');
      signInForm.classList.add('active');
      signUpForm.classList.remove('active');
    } else {
      signUpTab.classList.add('active');
      signInTab.classList.remove('active');
      signUpForm.classList.add('active');
      signInForm.classList.remove('active');
    }
  }

  signInTab?.addEventListener('click', () => switchTab('signin'));
  signUpTab?.addEventListener('click', () => switchTab('signup'));
  switchTab('signin');

  // Email Sign In
  document.getElementById('btn-signin')?.addEventListener('click', async () => {
    const email = document.getElementById('signin-email')?.value.trim();
    const password = document.getElementById('signin-password')?.value;
    if (!email || !password) { showError('signin-error', 'Please fill in all fields'); return; }
    showLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      currentUser = cred.user;
      await loadUserProfile();
    } catch (err) {
      showError('signin-error', err.message.replace('Firebase: ', '').replace(' (auth/invalid-credential).',''));
    }
    showLoading(false);
  });

  // Email Sign Up
  document.getElementById('btn-signup')?.addEventListener('click', async () => {
    const name = document.getElementById('signup-name')?.value.trim();
    const email = document.getElementById('signup-email')?.value.trim();
    const password = document.getElementById('signup-password')?.value;
    if (!name || !email || !password) { showError('signup-error', 'Please fill in all fields'); return; }
    if (password.length < 6) { showError('signup-error', 'Password must be at least 6 characters'); return; }
    showLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      currentUser = cred.user;
      await createUserProfile(currentUser, { displayName: name });
      await loadUserProfile();
    } catch (err) {
      showError('signup-error', err.message.replace('Firebase: ', '').replace(' (auth/email-already-in-use).','').replace(' (auth/weak-password).',''));
    }
    showLoading(false);
  });

  // Google OAuth
  const handleGoogleSignIn = async () => {
    showLoading(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      currentUser = cred.user;
      await createUserProfile(currentUser);
      await loadUserProfile();
    } catch (err) {
      const errorMsg = err.message.replace('Firebase: ', '').replace(/\s*\(auth\/[^\)]+\)/g, '');
      showError('auth-error', errorMsg);
    }
    showLoading(false);
  };

  document.getElementById('btn-google-signin')?.addEventListener('click', handleGoogleSignIn);
  document.getElementById('btn-google-signup')?.addEventListener('click', handleGoogleSignIn);

  // Logout
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await signOut(auth);
    currentUser = null;
    currentUserProfile = null;
    showScreen('auth-screen');
  });

  // Auth state listener
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      await loadUserProfile();
    } else {
      showScreen('auth-screen');
    }
  });
}

async function loadUserProfile() {
  if (!currentUser) return;
  currentUserProfile = await getUserProfile(currentUser.uid);
  updateDashboard();
  showScreen('dashboard-screen');
}

function updateDashboard() {
  if (!currentUserProfile) return;
  const name = currentUserProfile.displayName || currentUser.email.split('@')[0];
  document.getElementById('dash-name').textContent = name;
  document.getElementById('dash-email').textContent = currentUser.email;
  const badgeEl = document.getElementById('user-badge');
  if (badgeEl) {
    badgeEl.className = currentUserProfile.isAdmin ? 'badge badge-admin' : 'badge badge-user';
    badgeEl.textContent = currentUserProfile.isAdmin ? 'ADMIN' : 'USER';
  }
  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel) adminPanel.style.display = currentUserProfile.isAdmin ? 'block' : 'none';
}

// ── DASHBOARD ────────────────────────────────────────────────
function initDashboard() {
  document.getElementById('btn-create')?.addEventListener('click', async () => {
    const name = document.getElementById('input-meeting-name')?.value.trim();
    if (!name) { showError('join-error', 'Please enter a meeting name'); return; }
    if (!currentUser || !currentUserProfile) return;
    roomType = document.getElementById('input-room-type')?.value || 'boardroom';
    meetingName = name;
    showLoading(true);
    try {
      const meeting = await apiCreateMeeting(
        currentUser.uid,
        currentUserProfile.displayName || currentUser.email,
        meetingName, roomType
      );
      meetingCode = meeting.id;
      document.getElementById('meeting-link').textContent = meeting.link;
      document.getElementById('link-box').style.display = 'flex';
      document.getElementById('link-note').style.display = 'block';
    } catch (err) {
      meetingCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      meetingName = name;
      const link = `presence://meet/${meetingCode}`;
      document.getElementById('meeting-link').textContent = link;
      document.getElementById('link-box').style.display = 'flex';
      document.getElementById('link-note').style.display = 'block';
    }
    showLoading(false);
  });

  document.getElementById('btn-copy')?.addEventListener('click', () => {
    const link = document.getElementById('meeting-link').textContent;
    navigator.clipboard.writeText(link).then(() => {
      const btn = document.getElementById('btn-copy');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  });

  document.getElementById('btn-join')?.addEventListener('click', async () => {
    const input = document.getElementById('input-join-code')?.value.trim();
    if (!input) { showError('join-error', 'Please paste a meeting link or code'); return; }
    const parts = input.split('/');
    meetingCode = parts[parts.length - 1].toUpperCase();
    meetingName = 'PRESENCE Meeting';
    roomType = document.getElementById('input-room-type')?.value || 'boardroom';
    showLoading(true);
    try {
      const meeting = await apiGetMeeting(meetingCode);
      if (meeting && meeting.name) {
        meetingName = meeting.name;
        roomType = meeting.roomType || roomType;
        await apiJoinMeeting(meetingCode, currentUser.uid, currentUserProfile?.displayName || currentUser.email);
        await joinMeeting(meetingCode, currentUser.uid, currentUserProfile?.displayName || currentUser.email);
      }
    } catch (err) { /* proceed anyway */ }
    showLoading(false);
    enterMeeting();
  });
}

// ── MEETING ─────────────────────────────────────────────────
function enterMeeting() {
  if (!currentUserProfile) return;
  meetingTimer = 0;
  document.getElementById('hud-user').textContent = currentUserProfile.displayName || currentUser.email;
  document.getElementById('hud-user-name').textContent = currentUserProfile.displayName || currentUser.email;
  document.getElementById('hud-code').textContent = meetingCode;
  document.getElementById('hud-room-type').textContent = getRoomLabel(roomType);
  const userDot = document.getElementById('user-dot');
  if (userDot) {
    userDot.style.background = 'rgba(99,102,241,0.3)';
    userDot.style.color = 'var(--primary-light)';
    userDot.textContent = (currentUserProfile.displayName || currentUser.email || 'Y').charAt(0).toUpperCase();
  }
  timerInterval = setInterval(() => {
    meetingTimer++;
    const m = String(Math.floor(meetingTimer / 60)).padStart(2, '0');
    const s = String(meetingTimer % 60).padStart(2, '0');
    const timerEl = document.getElementById('hud-timer');
    if (timerEl) timerEl.textContent = `${m}:${s}`;
  }, 1000);
  document.querySelectorAll('.screen').forEach(el => el.style.display = 'none');
  document.getElementById('three-canvas').style.display = 'block';
  const meetingScreen = document.getElementById('meeting-screen');
  if (meetingScreen) meetingScreen.style.display = 'flex';
  const muteBtn = document.getElementById('btn-mute');
  if (muteBtn) { muteBtn.textContent = '🎤 Mute'; muteBtn.classList.remove('muted'); muted = false; }

  // Initialize Agora session (voice + spatial audio)
  initAgoraSession().then(joined => {
    if (joined) {
      console.log('🎙️ Agora voice session active');
      // Prompt user to use headphones
      const navHint = document.querySelector('.nav-hint-bar');
      if (navHint) navHint.innerHTML = '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · Mouse look · <span style="color:#10b981">🎧 Voice active</span>';
    }
  });

  initThreeJS();
}

function getRoomLabel(type) {
  return { boardroom: '🏢 Boardroom', studio: '🎨 Creative Studio', lounge: '☕ Casual Lounge', classroom: '📚 Classroom' }[type] || '🏢 Boardroom';
}

function initControls() {
  const muteBtn = document.getElementById('btn-mute');
  muteBtn?.addEventListener('click', () => {
    muted = !muted;
    if (muted) {
      muteBtn.textContent = '🔇 Unmute';
      muteBtn.classList.add('muted');
    } else {
      muteBtn.textContent = '🎤 Mute';
      muteBtn.classList.remove('muted');
    }
    // Actually mute Agora audio
    if (agoraClient) agoraClient.setMute(muted);
  });

  document.getElementById('btn-leave')?.addEventListener('click', async () => {
    clearInterval(timerInterval);
    if (agoraClient) await agoraClient.leaveChannel();
    if (renderer) { renderer.dispose(); renderer = null; }
    try {
      await apiLeaveMeeting(meetingCode, currentUser?.uid);
      await leaveMeeting(meetingCode, currentUser?.uid);
    } catch (err) { /* ignore */ }
    showSummary();
  });

  document.getElementById('btn-done')?.addEventListener('click', () => {
    document.getElementById('summary-screen').classList.remove('show');
    showScreen('dashboard-screen');
  });
}

// ── THREE.JS HELPERS ─────────────────────────────────────────
function addMesh(scene, geo, matProps, pos=[0,0,0], rot=[0,0,0], basic=false) {
  const MatClass = basic ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
  const mesh = new THREE.Mesh(geo, new MatClass(matProps));
  mesh.position.set(...pos); mesh.rotation.set(...rot);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh); return mesh;
}

function makeWalls(scene, color) {
  const mat = new THREE.MeshStandardMaterial({ color });
  [[20,6,0,3,-10,0],[20,6,0,3,10,Math.PI],[20,6,-10,3,0,Math.PI/2],[20,6,10,3,0,-Math.PI/2]].forEach(([w,h,x,y,z,ry]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w,h), mat);
    m.position.set(x,y,z); m.rotation.y = ry; scene.add(m);
  });
}

function makeTextCanvas(title, w, h, bg, fg, size) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0,0,w,h);
  ctx.fillStyle = fg; ctx.font = `bold ${size}px Arial`; ctx.textAlign = 'center';
  ctx.fillText(title, w/2, h/2);
  return c;
}

function makeSign(scene, title, sub, x, y, z, titleColor='#6366f1', subColor='#818cf8') {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0,0,1024,256);
  ctx.fillStyle = titleColor; ctx.font = 'bold 80px Arial'; ctx.textAlign = 'center';
  ctx.fillText(title, 512, 140);
  ctx.fillStyle = subColor; ctx.font = '28px Arial';
  ctx.fillText(sub, 512, 200);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(7,1.5),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true })
  );
  sign.position.set(x,y,z); scene.add(sign);
}

function makeNameTag(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `${color}cc`;
  ctx.roundRect(0,0,256,64,12); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 26px Arial'; ctx.textAlign = 'center';
  ctx.fillText(name, 128, 42);
  return new THREE.CanvasTexture(c);
}

function addLight(scene, color, intensity, distance, x, y, z) {
  const light = new THREE.PointLight(color, intensity, distance);
  light.position.set(x,y,z); scene.add(light);
}

// ── ROOM BUILDERS ────────────────────────────────────────────
function buildBoardroom(scene) {
  addMesh(scene, new THREE.PlaneGeometry(20,20), { color: 0x1a1a2e }, [0,0,0], [-Math.PI/2,0,0]);
  addMesh(scene, new THREE.PlaneGeometry(20,20), { color: 0x0d0d1a }, [0,6,0], [Math.PI/2,0,0]);
  makeWalls(scene, 0x16213e);
  addMesh(scene, new THREE.BoxGeometry(5,0.12,2), { color: 0x5c3d2e }, [0,0.8,0]);
  [[-2.3,.8],[2.3,.8],[-2.3,-.8],[2.3,-.8]].forEach(([x,z]) =>
    addMesh(scene, new THREE.CylinderGeometry(.06,.06,.8), { color: 0x3a2415 }, [x,.4,z]));
  [[-2,1.5,0],[0,1.5,0],[2,1.5,0],[-2,-1.5,Math.PI],[0,-1.5,Math.PI],[2,-1.5,Math.PI]].forEach(([x,z,ry]) => {
    addMesh(scene, new THREE.BoxGeometry(.5,.05,.5), { color: 0x0f3460 }, [x,.55,z],[0,ry,0]);
    addMesh(scene, new THREE.BoxGeometry(.5,.5,.05), { color: 0x0f3460 }, [x,.85,z+(ry===0?-.25:.25)]);
  });
  addMesh(scene, new THREE.BoxGeometry(4,2.5,0.05), { color: 0x111122 }, [0,2.5,-9.3]);
  const screenCanvas = makeTextCanvas('PRESENTATION', 800, 500, '#1a1a3e', '#6366f1', 60);
  addMesh(scene, new THREE.PlaneGeometry(3.8,2.3), { map: new THREE.CanvasTexture(screenCanvas) }, [0,2.5,-9.25],[0,0,0],true);
  for (const x of [-3, 0, 3]) {
    addMesh(scene, new THREE.BoxGeometry(0.8,0.05,0.8), { color: 0xaaaaff }, [x,5.95,0]);
    addLight(scene, 0x6366f1, 1.5, 12, x, 5.5, 0);
  }
  makeSign(scene, 'PRESENCE', 'Where Remote Meetings Finally Feel Real', 0, 4.5, -9.35);
}

function buildCreativeStudio(scene) {
  addMesh(scene, new THREE.PlaneGeometry(20,20), { color: 0x1a0a2e }, [0,0,0], [-Math.PI/2,0,0]);
  addMesh(scene, new THREE.PlaneGeometry(20,20), { color: 0x0d0a1a }, [0,6,0], [Math.PI/2,0,0]);
  makeWalls(scene, 0x1e0a2e);
  addMesh(scene, new THREE.PlaneGeometry(20,6), { color: 0x2d0a4e }, [0,3,-10]);
  addMesh(scene, new THREE.CylinderGeometry(2,2,0.1,32), { color: 0x8B4513 }, [0,0.75,0]);
  addMesh(scene, new THREE.CylinderGeometry(0.1,0.1,0.75,8), { color: 0x5c3317 }, [0,0.375,0]);
  for (let i = 0; i < 6; i++) {
    const angle = (i/6) * Math.PI * 2;
    const x = Math.sin(angle) * 2.8;
    const z = Math.cos(angle) * 2.8;
    addMesh(scene, new THREE.CylinderGeometry(.3,.3,.05,16), { color: 0x9b59b6 }, [x,.55,z]);
    addMesh(scene, new THREE.CylinderGeometry(.04,.04,.5,8), { color: 0x6c3483 }, [x,.275,z]);
  }
  addMesh(scene, new THREE.BoxGeometry(4,2.5,0.05), { color: 0xf5f5f5 }, [-6,2.5,-9.3]);
  addMesh(scene, new THREE.BoxGeometry(4,2.5,0.05), { color: 0xf5f5f5 }, [4,2.5,-9.3]);
  const wbCanvas = makeTextCanvas('WHITEBOARD', 800, 500, '#f5f5f5', '#9b59b6', 50);
  addMesh(scene, new THREE.PlaneGeometry(3.8,2.3), { map: new THREE.CanvasTexture(wbCanvas) }, [-6,2.5,-9.25],[0,0,0],true);
  const colors = [0xff6b6b, 0x4ecdc4, 0xffe66d, 0x9b59b6];
  colors.forEach((c, i) => {
    const x = (i - 1.5) * 4;
    addMesh(scene, new THREE.SphereGeometry(0.15,8,8), { color: c }, [x,5.8,0]);
    addLight(scene, c, 1.2, 14, x, 5.5, 0);
  });
  makeSign(scene, 'CREATIVE STUDIO', 'Ideate · Collaborate · Create', 0, 4.5, -9.35, '#9b59b6', '#cc88ff');
}

function buildLounge(scene) {
  addMesh(scene, new THREE.PlaneGeometry(20,20), { color: 0x1a1208 }, [0,0,0], [-Math.PI/2,0,0]);
  addMesh(scene, new THREE.PlaneGeometry(20,20), { color: 0x0f0d06 }, [0,6,0], [Math.PI/2,0,0]);
  makeWalls(scene, 0x1c1508);
  addMesh(scene, new THREE.PlaneGeometry(20,6), { color: 0x2c1a08 }, [0,3,-10]);
  addMesh(scene, new THREE.CylinderGeometry(1,1,0.08,16), { color: 0x8B6914 }, [0,0.45,0]);
  addMesh(scene, new THREE.CylinderGeometry(0.08,0.08,0.45,8), { color: 0x5c4510 }, [0,0.225,0]);
  function makeSofa(x, z, ry) {
    addMesh(scene, new THREE.BoxGeometry(2,.4,.8), { color: 0x8B4513 }, [x,.3,z],[0,ry,0]);
    addMesh(scene, new THREE.BoxGeometry(2,.6,.15), { color: 0x7a3b10 }, [x,.55,z+(ry===0?-.4:.4)],[0,ry,0]);
    addMesh(scene, new THREE.BoxGeometry(.15,.6,.8), { color: 0x7a3b10 }, [x+(ry===0?-.9:.9),.45,z],[0,ry,0]);
    addMesh(scene, new THREE.BoxGeometry(.15,.6,.8), { color: 0x7a3b10 }, [x+(ry===0?.9:-.9),.45,z],[0,ry,0]);
  }
  makeSofa(0,2.2,0); makeSofa(0,-2.2,Math.PI); makeSofa(3.2,0,Math.PI/2); makeSofa(-3.2,0,-Math.PI/2);
  function makePlant(x, z) {
    addMesh(scene, new THREE.CylinderGeometry(.2,.25,.3,8), { color: 0x8B4513 }, [x,.15,z]);
    addMesh(scene, new THREE.SphereGeometry(.35,8,8), { color: 0x2d5a1b }, [x,.6,z]);
  }
  makePlant(-8,-8); makePlant(8,-8); makePlant(-8,8); makePlant(8,8);
  addLight(scene, 0xff9944, 2, 18, -3, 4.5, 0);
  addLight(scene, 0xffcc66, 2, 18, 3, 4.5, 0);
  makeSign(scene, 'CASUAL LOUNGE', 'Relax · Connect · Unwind', 0, 4.5, -9.35, '#f39c12', '#ffcc88');
}

function buildClassroom(scene) {
  addMesh(scene, new THREE.PlaneGeometry(20,20), { color: 0x0a1628 }, [0,0,0], [-Math.PI/2,0,0]);
  addMesh(scene, new THREE.PlaneGeometry(20,20), { color: 0x060e1a }, [0,6,0], [Math.PI/2,0,0]);
  makeWalls(scene, 0x0d1f35);
  addMesh(scene, new THREE.BoxGeometry(3,.1,1.2), { color: 0x5c3d2e }, [0,.75,-7]);
  addMesh(scene, new THREE.BoxGeometry(2.8,1.5,.05), { color: 0x111122 }, [0,1.5,-9.2]);
  const boardCanvas = makeTextCanvas('LECTURE BOARD', 800, 500, '#111122', '#4488ff', 50);
  addMesh(scene, new THREE.PlaneGeometry(2.6,1.3), { map: new THREE.CanvasTexture(boardCanvas) }, [0,1.5,-9.15],[0,0,0],true);
  for (let row = 0; row < 3; row++) {
    for (let col = -2; col <= 2; col++) {
      const x = col * 3; const z = row * 2.5 - 1;
      addMesh(scene, new THREE.BoxGeometry(1.2,.06,.7), { color: 0x4a3728 }, [x,.7,z]);
      addMesh(scene, new THREE.BoxGeometry(.4,.05,.4), { color: 0x0f3460 }, [x,.5,z+.5]);
    }
  }
  for (const x of [-4, 0, 4]) {
    addMesh(scene, new THREE.BoxGeometry(1.5,.05,.3), { color: 0xddddff }, [x,5.95,0]);
    addLight(scene, 0xffffff, 1.5, 14, x, 5.5, 0);
  }
  makeSign(scene, 'CLASSROOM', 'Learn · Engage · Grow', 0, 4.5, -9.35, '#4488ff', '#88aaff');
}

// ── THREE.JS INIT ────────────────────────────────────────────
function initThreeJS() {
  const canvas = document.getElementById('three-canvas');
  const scene = new THREE.Scene();
  const roomSettings = {
    boardroom: { bg: 0x0a0a0f, fog: 0x0a0a0f },
    studio: { bg: 0x0d0a1a, fog: 0x0d0a1a },
    lounge: { bg: 0x120d06, fog: 0x120d06 },
    classroom: { bg: 0x060e1a, fog: 0x060e1a },
  };
  const settings = roomSettings[roomType] || roomSettings.boardroom;
  scene.background = new THREE.Color(settings.bg);
  scene.fog = new THREE.Fog(settings.fog, 12, 50);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.6, 6);

  renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(5,10,5); dir.castShadow = true; scene.add(dir);

  const builders = { boardroom: buildBoardroom, studio: buildCreativeStudio, lounge: buildLounge, classroom: buildClassroom };
  (builders[roomType] || buildBoardroom)(scene);

  // Mock remote participants (in production, these come from Agora data channel)
  const mockOthers = [
    { uid: 1001, name: 'Alex', x: -2, z: 1.5, color: 0xe74c3c },
    { uid: 1002, name: 'Sarah', x: 2, z: 1.5, color: 0x2ecc71 },
    { uid: 1003, name: 'James', x: -2, z: -1.5, color: 0xf39c12 },
  ];

  otherAvatars = mockOthers.map(u => {
    const body = addMesh(scene, new THREE.CapsuleGeometry(.25,.8,4,8), { color: u.color }, [u.x,1,u.z]);
    const head = addMesh(scene, new THREE.SphereGeometry(.2,16,16), { color: 0xe8b89a }, [u.x,1.9,u.z]);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(.32,.38,32),
      new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    ring.position.set(u.x,1,u.z); ring.rotation.x = -Math.PI/2; scene.add(ring);
    const tag = addMesh(scene, new THREE.PlaneGeometry(.9,.22), { map: makeNameTag(u.name), transparent: true }, [u.x,2.4,u.z],[0,0,0],true);
    const remoteUser = { ...u, body, head, ring, tag, targetX: u.x, targetY: 1, targetZ: u.z };
    // Initialize in remote users map
    remoteUsers.set(u.uid, { position: { x: u.x, y: 1, z: u.z }, name: u.name });
    return remoteUser;
  });

  // User avatar
  const userColor = 0x6366f1;
  const userBody = addMesh(scene, new THREE.CapsuleGeometry(.25,.8,4,8), { color: userColor }, [0,1,4]);
  const userHead = addMesh(scene, new THREE.SphereGeometry(.2,16,16), { color: 0xe8b89a }, [0,1.9,4]);
  const userTag = addMesh(scene, new THREE.PlaneGeometry(.9,.22), { map: makeNameTag(currentUserProfile?.displayName || 'You', '#6366f1'), transparent: true }, [0,2.4,4],[0,0,0],true);
  const userRing = new THREE.Mesh(
    new THREE.RingGeometry(.32,.38,32),
    new THREE.MeshBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0, side: THREE.DoubleSide })
  );
  userRing.position.set(0,1,4); userRing.rotation.x = -Math.PI/2; scene.add(userRing);

  // Navigation
  const keys = {};
  const onKey = e => keys[e.key] = e.type === 'keydown';
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  let mouseX = 0;
  window.addEventListener('mousemove', e => { mouseX = (e.clientX/window.innerWidth - 0.5) * 2; });
  window.addEventListener('resize', () => {
    if (!renderer) return;
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const speed = 0.06;
  let cameraYaw = 0;

  function animate() {
    if (!renderer) return;
    requestAnimationFrame(animate);
    const t = Date.now() * 0.001;

    // Update camera yaw for listener orientation
    cameraYaw = -mouseX * 0.3;

    let moved = false;
    const prevX = userBody.position.x;
    const prevZ = userBody.position.z;

    if (keys['w']||keys['ArrowUp']) { userBody.position.z-=speed; userHead.position.z-=speed; userTag.position.z-=speed; userRing.position.z-=speed; camera.position.z-=speed; moved = true; }
    if (keys['s']||keys['ArrowDown']) { userBody.position.z+=speed; userHead.position.z+=speed; userTag.position.z+=speed; userRing.position.z+=speed; camera.position.z+=speed; moved = true; }
    if (keys['a']||keys['ArrowLeft']) { userBody.position.x-=speed; userHead.position.x-=speed; userTag.position.x-=speed; userRing.position.x-=speed; camera.position.x-=speed; moved = true; }
    if (keys['d']||keys['ArrowRight']) { userBody.position.x+=speed; userHead.position.x+=speed; userTag.position.x+=speed; userRing.position.x+=speed; camera.position.x+=speed; moved = true; }

    camera.rotation.y = cameraYaw;

    // Update user position for spatial audio and Agora broadcast
    if (moved) {
      userPosition.x = userBody.position.x;
      userPosition.y = 1;
      userPosition.z = userBody.position.z;
    }

    // Update spatial audio listener position and orientation
    if (spatialAudioManager && spatialAudioManager.initialized) {
      spatialAudioManager.updateListenerPosition(
        camera.position.x,
        camera.position.y,
        camera.position.z
      );
      spatialAudioManager.updateListenerOrientation(cameraYaw, 0);
    }

    // Avatar breathing animation
    userBody.position.y = 1 + Math.sin(t*1.5)*0.015;
    userHead.position.y = 1.9 + Math.sin(t*1.5)*0.015;

    // Smooth interpolation for remote avatars
    otherAvatars.forEach((u, i) => {
      // Smooth lerp towards target position
      if (u.targetX !== undefined) {
        u.body.position.x += (u.targetX - u.body.position.x) * 0.1;
        u.body.position.z += (u.targetZ - u.body.position.z) * 0.1;
        u.head.position.x = u.body.position.x;
        u.head.position.z = u.body.position.z;
        u.head.position.y = 1.9 + Math.sin(t + i)*0.015;
        u.ring.position.x = u.body.position.x;
        u.ring.position.z = u.body.position.z;
        u.tag.position.x = u.body.position.x;
        u.tag.position.z = u.body.position.z;
        u.body.position.y = 1 + Math.sin(t + i)*0.015;
      } else {
        u.body.position.y = 1 + Math.sin(t + i)*0.015;
        u.head.position.y = 1.9 + Math.sin(t + i)*0.015;
      }

      // Speaking indicator (random for mock participants)
      const speaking = Math.sin(t * (1.2 + i * 0.4) + i * 2) > 0.6;
      u.ring.material.opacity = speaking ? 0.6 + Math.sin(t*8)*0.3 : 0;
    });

    // User speaking ring
    userRing.material.opacity = (!muted && Math.sin(t * 2.1) > 0.5) ? 0.5 + Math.sin(t*10)*0.3 : 0;

    // Name tags always face camera
    [...otherAvatars.map(u=>u.tag), userTag].forEach(tag => tag.lookAt(camera.position));

    renderer.render(scene, camera);
  }
  animate();
}

// ── AI SUMMARY ───────────────────────────────────────────────
async function showSummary() {
  const summaryScreen = document.getElementById('summary-screen');
  summaryScreen.classList.add('show');
  const mins = Math.floor(meetingTimer / 60);
  const secs = meetingTimer % 60;
  const metaEl = document.getElementById('summary-meta');
  if (metaEl) metaEl.innerHTML = `<strong>${meetingName}</strong> · ${getRoomLabel(roomType)} · Duration: <strong>${mins}m ${secs}s</strong> · <strong>4 participants</strong>`;
  const participants = [
    { name: currentUserProfile?.displayName || currentUser?.email || 'You', color: '#6366f1' },
    { name: 'Alex', color: '#f87171' },
    { name: 'Sarah', color: '#34d399' },
    { name: 'James', color: '#fbbf24' },
  ];
  const partEl = document.getElementById('summary-participants');
  if (partEl) partEl.innerHTML = participants.map(p => `<span class="participant-chip"><span class="chip-dot" style="background:${p.color}"></span>${p.name}</span>`).join('');
  const topicsEl = document.getElementById('summary-topics');
  const decisionsEl = document.getElementById('summary-decisions');
  const actionsEl = document.getElementById('summary-actions');
  if (topicsEl) topicsEl.innerHTML = '<div class="summary-item"><div class="summary-item-icon">✨</div><span>Loading AI summary...</span></div>';
  if (decisionsEl) decisionsEl.innerHTML = '<div class="summary-item"><div class="summary-item-icon">📋</div><span>Processing...</span></div>';
  if (actionsEl) actionsEl.innerHTML = '<div class="summary-item"><div class="summary-item-icon">📝</div><span>Preparing action items...</span></div>';
  try {
    const fallbackTranscript = `The team gathered to discuss the project roadmap. Sarah presented the new design system and proposed timeline adjustments. Alex highlighted the API integration blockers. The group debated feature priorities and reached consensus on the core user journey. James offered to coordinate with the testing team for the next sprint.`;
    const summary = await apiSummarise(fallbackTranscript, meetingName, roomType, meetingTimer, participants.map(p=>p.name));
    if (topicsEl) topicsEl.innerHTML = (summary.topics || []).map(t => `<div class="summary-item"><div class="summary-item-icon">💬</div><span>${t}</span></div>`).join('');
    if (decisionsEl) decisionsEl.innerHTML = (summary.decisions || []).map(d => `<div class="summary-item"><div class="summary-item-icon">✅</div><span>${d}</span></div>`).join('');
    if (actionsEl) actionsEl.innerHTML = (summary.actions || []).map(a => `<div class="action-item"><span class="action-owner">${a.owner || 'Unassigned'}</span><span class="action-task">${a.task || ''}</span></div>`).join('');
  } catch (err) {
    console.error('Summary error:', err);
    if (topicsEl) topicsEl.innerHTML = ['Project roadmap and sprint priorities','Technical blockers and resource allocation','Client presentation preparation'].map(t => `<div class="summary-item"><div class="summary-item-icon">💬</div><span>${t}</span></div>`).join('');
    if (decisionsEl) decisionsEl.innerHTML = ['Onboarding flow prioritized for next sprint','Demo scheduled for end of next week'].map(d => `<div class="summary-item"><div class="summary-item-icon">✅</div><span>${d}</span></div>`).join('');
    if (actionsEl) actionsEl.innerHTML = [
      { owner: currentUserProfile?.displayName || 'You', task: 'Share updated roadmap document by Friday' },
      { owner: 'Alex', task: 'Resolve API integration blockers' },
      { owner: 'Sarah', task: 'Prepare demo environment and slides' },
    ].map(a => `<div class="action-item"><span class="action-owner">${a.owner}</span><span class="action-task">${a.task}</span></div>`).join('');
  }
}

// ── INIT ─────────────────────────────────────────────────────
function init() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('auth-screen').classList.add('visible');
  initAuth();
  initDashboard();
  initControls();
}

init();