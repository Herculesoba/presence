import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, addDoc, updateDoc, arrayUnion, serverTimestamp } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCHWunn4D-5GTI5HL4EqzYdPglu3Z9iojE",
  authDomain: "presence-app-8e5bd.firebaseapp.com",
  databaseURL: "https://presence-app-8e5bd-default-rtdb.firebaseio.com",
  projectId: "presence-app-8e5bd",
  storageBucket: "presence-app-8e5bd.firebasestorage.app",
  messagingSenderId: "670868245343",
  appId: "1:670868245343:web:c7a6fff240e673250284ea",
  measurementId: "G-81XPN8MW0G"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

export {
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  googleProvider,
  signOut,
  doc,
  setDoc,
  getDoc,
  collection,
  addDoc,
  updateDoc,
  arrayUnion,
  serverTimestamp
};

export async function createUserProfile(user, additionalData = {}) {
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || user.email.split('@')[0],
      photoURL: user.photoURL || null,
      isAdmin: false,
      createdAt: serverTimestamp(),
      ...additionalData
    });
  }
  return await getDoc(userRef);
}

export async function getUserProfile(uid) {
  const userRef = doc(db, 'users', uid);
  const snap = await getDoc(userRef);
  return snap.exists() ? snap.data() : null;
}

export async function createMeeting({ hostUid, hostName, name, roomType }) {
  const meetingsRef = collection(db, 'meetings');
  const docRef = await addDoc(meetingsRef, {
    hostUid,
    hostName,
    name,
    roomType,
    participants: [{ uid: hostUid, name: hostName, isHost: true }],
    status: 'waiting',
    createdAt: serverTimestamp(),
    link: '' // will be updated
  });
  const link = `presence://meet/${docRef.id}`;
  await updateDoc(doc(db, 'meetings', docRef.id), { link });
  return { id: docRef.id, name, roomType, link, hostUid, hostName };
}

export async function getMeeting(meetingId) {
  const snap = await getDoc(doc(db, 'meetings', meetingId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function joinMeeting(meetingId, uid, name) {
  const meetingRef = doc(db, 'meetings', meetingId);
  await updateDoc(meetingRef, {
    participants: arrayUnion({ uid, name, isHost: false }),
    status: 'active'
  });
}

export async function leaveMeeting(meetingId, uid) {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return;
  const updated = meeting.participants.filter(p => p.uid !== uid);
  await updateDoc(doc(db, 'meetings', meetingId), {
    participants: updated,
    status: updated.length === 0 ? 'ended' : 'active'
  });
}