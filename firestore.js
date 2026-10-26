import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

let app;

if (!getApps().length) {
  // Option 1: FIREBASE_SERVICE_ACCOUNT (full json string in env, ideal for Render)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const sa = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : process.env.FIREBASE_SERVICE_ACCOUNT;
      app = initializeApp({
        credential: cert(sa),
        projectId: process.env.FIREBASE_PROJECT_ID || sa.project_id || 'lawyer-managment-system-84847'
      });
      console.log('[Firestore] Successfully initialized via FIREBASE_SERVICE_ACCOUNT env var');
    } catch (e) {
      console.error('[Firestore] Error parsing FIREBASE_SERVICE_ACCOUNT:', e.message);
    }
  }

  // Option 2: local serviceAccountKey.json file in backend directory
  if (!app) {
    const keyPath = path.resolve(__dirname, './serviceAccountKey.json');
    if (fs.existsSync(keyPath)) {
      try {
        const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        app = initializeApp({
          credential: cert(sa),
          projectId: sa.project_id || 'lawyer-managment-system-84847'
        });
        console.log('[Firestore] Successfully initialized via local serviceAccountKey.json');
      } catch (e) {
        console.error('[Firestore] Error reading serviceAccountKey.json:', e.message);
      }
    }
  }

  // Option 3: FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY
  if (!app && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    try {
      app = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID || 'lawyer-managment-system-84847',
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
      });
      console.log('[Firestore] Successfully initialized via clientEmail and privateKey');
    } catch (e) {
      console.error('[Firestore] Error with env credentials:', e.message);
    }
  }

  // Option 4: Project ID fallback
  if (!app) {
    try {
      app = initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'lawyer-managment-system-84847'
      });
      console.log('[Firestore] Initialized with projectId fallback:', process.env.FIREBASE_PROJECT_ID || 'lawyer-managment-system-84847');
    } catch (e) {
      console.error('[Firestore] ProjectId fallback error:', e.message);
    }
  }
} else {
  app = getApps()[0];
}

export const firestore = getFirestore(app);
