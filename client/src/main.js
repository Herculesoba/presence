import * as THREE from 'three';
import {
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  googleProvider,
  signOut,
  createUserProfile,
  getUserProfile,
  createMeeting,
  getMeeting,
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
let meetingTranscript = '';

// ── SERVER API ───────────────────────────────────────────────
const API_BASE = ''; // set to Railway URL after deployment

async function apiAgoraToken(meetingId, uid) {
  const res = await fetch(`${API_BASE}/api/agora/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingId, uid: uid || Math.floor(Math.random() * 99999) })
  });
  return res.json();
}

async function apiSummarise(transcript, meetingName, roomType, duration, participants) {
  const res = await fetch(`${API_BASE}/api/ai/summarise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, meetingName, roomType, duration, participants })
  });
  return res.json();
}

async function apiCreateMeeting(hostUid, hostName, name, roomType) {
  const res = await fetch(`${API_BASE}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostUid, hostName, name, roomType })
  });
  return res.json();
}

async function apiGetMeeting(id) {
  const res = await fetch(`${API_BASE}/api/meetings/${id}`);
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

// ── SCREEN MANAGER ───────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => {
    el.style.opacity = '0';
    setTimeout(() => el.style.display = 'none', 300);
  });
  const target = document.getElementById(id);
  if (target) {
    setTimeout(() => {
      target.style.display = 'flex';
      setTimeout(() => target.style.opacity = '1', 10);
    }, 300);
  }
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.style.display = 'block'; }
  setTimeout(() => { if (el) el.style.display = 'none'; }, 4000);
}

function showLoading(show) {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = show ? 'flex' : 'none';
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

  // Google OAuth (both sign-in and sign-up screens)
  const googleSignInBtn = document.getElementById('btn-google');
  const googleSignUpBtn = document.getElementById('btn-google-signup');

  const handleGoogleSignIn = async () => {
    showLoading(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      currentUser = cred.user;
      await createUserProfile(currentUser);
      await loadUserProfile();
    } catch (err) {
      showError('signin-error', err.message.replace('Firebase: ', ''));
    }
    showLoading(false);
  };

  googleSignInBtn?.addEventListener('click', handleGoogleSignIn);
  googleSignUpBtn?.addEventListener('click', handleGoogleSignIn);

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
    if (currentUserProfile.isAdmin) {
      badgeEl.className = 'admin-badge';
      badgeEl.textContent = 'ADMIN';
    } else {
      badgeEl.className = 'user-badge';
      badgeEl.textContent = 'USER';
    }
  }

  // Admin panel
  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel) {
    adminPanel.style.display = currentUserProfile.isAdmin ? 'block' : 'none';
  }
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
        meetingName,
        roomType
      );
      meetingCode = meeting.id;
      document.getElementById('meeting-link').textContent = meeting.link;
      document.getElementById('link-box').style.display = 'flex';
      document.getElementById('link-note').style.display = 'block';
    } catch (err) {
      // fallback: generate locally
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
      setTimeout(() => btn.textContent = 'Copy Link', 2000);
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
    } catch (err) {
      // meeting may not exist in server yet — proceed anyway
    }
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
  document.getElementById('user-dot').style.background = '#4466ff';

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

  initThreeJS();
}

function getRoomLabel(type) {
  const labels = {
    boardroom: '🏢 Boardroom',
    studio: '🎨 Creative Studio',
    lounge: '☕ Casual Lounge',
    classroom: '📚 Classroom'
  };
  return labels[type] || '🏢 Boardroom';
}

function initControls() {
  document.getElementById('btn-mute')?.addEventListener('click', () => {
    muted = !muted;
    const btn = document.getElementById('btn-mute');
    if (btn) {
      btn.textContent = muted ? '🔇 Unmute' : '🎤 Mute';
      btn.style.background = muted ? 'rgba(200,50,50,0.8)' : '';
    }
  });

  document.getElementById('btn-leave')?.addEventListener('click', async () => {
    clearInterval(timerInterval);
    if (renderer) { renderer.dispose(); renderer = null; }
    try {
      await apiLeaveMeeting(meetingCode, currentUser?.uid);
      await leaveMeeting(meetingCode, currentUser?.uid);
    } catch (err) { /* ignore */ }
    showSummary();
  });

  document.getElementById('btn-done')?.addEventListener('click', () => {
    document.getElementById('summary-screen').style.display = 'none';
    showScreen('dashboard-screen');
  });
}

// ── THREE.JS ROOM BUILDERS ───────────────────────────────────
function addMesh(scene, geo, matProps, pos=[0,0,0], rot=[0,0,0], basic=false) {
  const MatClass = basic ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
  const mesh = new THREE.Mesh(geo, new MatClass(matProps));
  mesh.position.set(...pos);
  mesh.rotation.set(...rot);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
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

function makeSign(scene, title, sub, x, y, z, titleColor='#4466ff', subColor='#8899ff') {
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
  light.position.set(x,y,z);
  scene.add(light);
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
  const screenCanvas = makeTextCanvas('PRESENTATION', 800, 500, '#1a1a3e', '#4466ff', 60);
  addMesh(scene, new THREE.PlaneGeometry(3.8,2.3), { map: new THREE.CanvasTexture(screenCanvas) }, [0,2.5,-9.25],[0,0,0],true);
  for (const x of [-3, 0, 3]) {
    addMesh(scene, new THREE.BoxGeometry(0.8,0.05,0.8), { color: 0xaaaaff }, [x,5.95,0]);
    addLight(scene, 0x4466ff, 1.5, 12, x, 5.5, 0);
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
  makeSofa(0,2.2,0); makeSofa(0,-2.2,Math.PI);
  makeSofa(3.2,0,Math.PI/2); makeSofa(-3.2,0,-Math.PI/2);
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
  renderer.setPixelRatio(window.devicePixelRatio);

  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(5,10,5); dir.castShadow = true; scene.add(dir);

  const builders = {
    boardroom: buildBoardroom,
    studio: buildCreativeStudio,
    lounge: buildLounge,
    classroom: buildClassroom
  };
  (builders[roomType] || buildBoardroom)(scene);

  // Other participants (mock for demo)
  const others = [
    { name: 'Alex', x: -2, z: 1.5, color: 0xe74c3c },
    { name: 'Sarah', x: 2, z: 1.5, color: 0x2ecc71 },
    { name: 'James', x: -2, z: -1.5, color: 0xf39c12 },
  ];

  const otherAvatars = others.map(u => {
    const body = addMesh(scene, new THREE.CapsuleGeometry(.25,.8,4,8), { color: u.color }, [u.x,1,u.z]);
    const head = addMesh(scene, new THREE.SphereGeometry(.2,16,16), { color: 0xe8b89a }, [u.x,1.9,u.z]);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(.32,.38,32),
      new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    ring.position.set(u.x,1,u.z); ring.rotation.x = -Math.PI/2; scene.add(ring);
    const tag = addMesh(scene, new THREE.PlaneGeometry(.9,.22), { map: makeNameTag(u.name), transparent: true }, [u.x,2.4,u.z],[0,0,0],true);
    return { body, head, ring, tag, ...u };
  });

  // User avatar
  const userColor = 0x4466ff;
  const userBody = addMesh(scene, new THREE.CapsuleGeometry(.25,.8,4,8), { color: userColor }, [0,1,4]);
  const userHead = addMesh(scene, new THREE.SphereGeometry(.2,16,16), { color: 0xe8b89a }, [0,1.9,4]);
  const userTag = addMesh(scene, new THREE.PlaneGeometry(.9,.22), { map: makeNameTag(currentUserProfile?.displayName || 'You', '#4466ff'), transparent: true }, [0,2.4,4],[0,0,0],true);
  const userRing = new THREE.Mesh(
    new THREE.RingGeometry(.32,.38,32),
    new THREE.MeshBasicMaterial({ color: 0x4466ff, transparent: true, opacity: 0, side: THREE.DoubleSide })
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

  function animate() {
    if (!renderer) return;
    requestAnimationFrame(animate);
    const t = Date.now() * 0.001;

    if (keys['w']||keys['ArrowUp']) {
      userBody.position.z-=speed; userHead.position.z-=speed; userTag.position.z-=speed; userRing.position.z-=speed; camera.position.z-=speed;
    }
    if (keys['s']||keys['ArrowDown']) {
      userBody.position.z+=speed; userHead.position.z+=speed; userTag.position.z+=speed; userRing.position.z+=speed; camera.position.z+=speed;
    }
    if (keys['a']||keys['ArrowLeft']) {
      userBody.position.x-=speed; userHead.position.x-=speed; userTag.position.x-=speed; userRing.position.x-=speed; camera.position.x-=speed;
    }
    if (keys['d']||keys['ArrowRight']) {
      userBody.position.x+=speed; userHead.position.x+=speed; userTag.position.x+=speed; userRing.position.x+=speed; camera.position.x+=speed;
    }
    camera.rotation.y = -mouseX * 0.3;

    userBody.position.y = 1 + Math.sin(t*1.5)*0.015;
    userHead.position.y = 1.9 + Math.sin(t*1.5)*0.015;

    otherAvatars.forEach((u, i) => {
      const speaking = Math.sin(t * (1.2 + i * 0.4) + i * 2) > 0.6;
      u.ring.material.opacity = speaking ? 0.6 + Math.sin(t*8)*0.3 : 0;
      u.body.position.y = 1 + Math.sin(t + i)*0.015;
      u.head.position.y = 1.9 + Math.sin(t + i)*0.015;
    });

    userRing.material.opacity = (!muted && Math.sin(t * 2.1) > 0.5) ? 0.5 + Math.sin(t*10)*0.3 : 0;

    [...otherAvatars.map(u=>u.tag), userTag].forEach(tag => tag.lookAt(camera.position));

    renderer.render(scene, camera);
  }
  animate();
}

// ── AI SUMMARY ───────────────────────────────────────────────
async function showSummary() {
  const summaryScreen = document.getElementById('summary-screen');
  summaryScreen.style.display = 'flex';

  const mins = Math.floor(meetingTimer/60);
  const secs = meetingTimer % 60;
  const metaEl = document.getElementById('summary-meta');
  if (metaEl) metaEl.textContent = `${meetingName}  ·  ${getRoomLabel(roomType)}  ·  Duration: ${mins}m ${secs}s  ·  4 participants`;

  const participants = [
    { name: currentUserProfile?.displayName || currentUser?.email || 'You', color: '#4466ff' },
    { name: 'Alex', color: '#e74c3c' },
    { name: 'Sarah', color: '#2ecc71' },
    { name: 'James', color: '#f39c12' },
  ];
  const partEl = document.getElementById('summary-participants');
  if (partEl) {
    partEl.innerHTML = participants.map(p =>
      `<span class="participant-chip"><span class="chip-dot" style="background:${p.color}"></span>${p.name}</span>`
    ).join('');
  }

  const topicsEl = document.getElementById('summary-topics');
  const decisionsEl = document.getElementById('summary-decisions');
  const actionsEl = document.getElementById('summary-actions');
  if (topicsEl) topicsEl.innerHTML = '<div class="summary-item">✨ AI is generating your summary...</div>';
  if (decisionsEl) decisionsEl.innerHTML = '<div class="summary-item">...</div>';
  if (actionsEl) actionsEl.innerHTML = '<div class="summary-item">...</div>';

  try {
    const fallbackTranscript = `The team discussed the project roadmap and upcoming sprint priorities. Alex raised a concern about API integration timelines. Sarah suggested prioritizing the onboarding flow. The group agreed on the client demo date and reviewed the presentation setup. James offered to handle the technical demo environment. Action items were assigned for documentation updates and demo preparation.`;

    const summary = await apiSummarise(
      fallbackTranscript,
      meetingName,
      roomType,
      meetingTimer,
      participants.map(p=>p.name)
    );

    if (topicsEl) {
      topicsEl.innerHTML = (summary.topics || []).map(t => `<div class="summary-item">${t}</div>`).join('');
    }
    if (decisionsEl) {
      decisionsEl.innerHTML = (summary.decisions || []).map(d => `<div class="summary-item">${d}</div>`).join('');
    }
    if (actionsEl) {
      actionsEl.innerHTML = (summary.actions || []).map(a =>
        `<div class="action-item"><span class="action-owner">${a.owner || 'Unassigned'}</span><span class="action-task">${a.task || ''}</span></div>`
      ).join('');
    }
  } catch (err) {
    console.error('Summary error:', err);
    // Fallback mock data
    if (topicsEl) topicsEl.innerHTML = [
      'Project roadmap and upcoming sprint priorities',
      'Blocker resolution and team dependencies',
      'Demo preparation and client presentation planning'
    ].map(t => `<div class="summary-item">${t}</div>`).join('');
    if (decisionsEl) decisionsEl.innerHTML = [
      'Core onboarding flow prioritised over secondary features',
      'Client demo confirmed for end of next week'
    ].map(d => `<div class="summary-item">${d}</div>`).join('');
    if (actionsEl) actionsEl.innerHTML = [
      { owner: currentUserProfile?.displayName || 'You', task: 'Share updated roadmap doc with the team by Friday' },
      { owner: 'Alex', task: 'Resolve API integration blocker and update the ticket' },
      { owner: 'Sarah', task: 'Prepare demo environment and presentation slides' },
    ].map(a => `<div class="action-item"><span class="action-owner">${a.owner}</span><span class="action-task">${a.task}</span></div>`).join('');
  }
}

// ── INIT ─────────────────────────────────────────────────────
function init() {
  showScreen('auth-screen');
  initAuth();
  initDashboard();
  initControls();
}

init();