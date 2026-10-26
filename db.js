import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import path from 'path';
import { firestoreDb } from "./firestore_db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const useFirestore = process.env.USE_FIRESTORE !== "false";

let pool = null;

if (!useFirestore) {
  const isRemote = process.env.DB_HOST && process.env.DB_HOST !== "localhost";
  console.log("=== SQL DB CONFIG ===");
  console.log("HOST:", process.env.DB_HOST);
  console.log("USER:", process.env.DB_USER);
  console.log("PORT:", process.env.DB_PORT);
  console.log("NAME:", process.env.DB_NAME);
  console.log("=====================");

  const { default: pg } = await import("pg");
  pool = new pg.Pool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "userdb",
    port: parseInt(process.env.DB_PORT) || 5432,
    ssl: isRemote ? { rejectUnauthorized: false } : undefined,
  });
} else {
  console.log("=== FIRESTORE DB ACTIVE ===");
  console.log("PROJECT:", process.env.FIREBASE_PROJECT_ID || "lawyer-managment-system-84847");
  console.log("DATABASE: Cloud Firestore");
  console.log("===========================");
}

export { pool };

export const db = {
  query: (text, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }

    if (useFirestore) {
      firestoreDb.execute(text, params)
        .then(result => {
          if (callback) callback(null, result);
        })
        .catch(err => {
          console.error("[Firestore Query Error]:", err);
          if (callback) callback(err);
        });
      return;
    }

    // Fallback: PostgreSQL pool
    let index = 1;
    const pgText = text.replace(/\?/g, () => `$${index++}`);

    return pool.query(pgText, params, (err, res) => {
      if (callback) {
        let result = res ? res.rows : [];
        if (res) {
          result.affectedRows = res.rowCount || 0;
          result.insertId = (res.rows && res.rows[0]) ? res.rows[0].id : null;
        }
        callback(err, result);
      }
    });
  },

  getConnection: (callback) => {
    if (useFirestore) {
      const connection = {
        query: (text, params, cb) => db.query(text, params, cb),
        release: () => {}
      };
      return callback(null, connection);
    }

    pool.connect((err, client, done) => {
      if (err) return callback(err);
      const connection = {
        query: (text, params, cb) => {
          let index = 1;
          const pgText = text.replace(/\?/g, () => `$${index++}`);
          return client.query(pgText, params, (err, res) => {
            if (cb) {
              const result = res ? res.rows : null;
              if (result && res.rowCount !== undefined) {
                result.affectedRows = res.rowCount;
              }
              cb(err, result);
            }
          });
        },
        release: () => done()
      };
      callback(null, connection);
    });
  }
};
