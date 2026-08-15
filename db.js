import pg from "pg";
import dotenv from "dotenv";

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const isRemote = process.env.DB_HOST && process.env.DB_HOST !== "localhost";

console.log("=== DB CONFIG ===");
console.log("HOST:", process.env.DB_HOST);
console.log("USER:", process.env.DB_USER);
console.log("PORT:", process.env.DB_PORT);
console.log("NAME:", process.env.DB_NAME);
console.log("PASSWORD SET:", process.env.DB_PASSWORD ? "YES" : "NO");
console.log("SSL:", isRemote ? "ENABLED" : "DISABLED");
console.log("=================");

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "userdb",
  port: parseInt(process.env.DB_PORT) || 5432,
  ssl: isRemote ? { rejectUnauthorized: false } : undefined,
});

// Compatibility wrapper for MySQL-style queries
export const db = {
  query: (text, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    
    // Convert ? to $1, $2, etc.
    let index = 1;
    const pgText = text.replace(/\?/g, () => `$${index++}`);
    
    // Log query for debugging (optional, can be removed later)
    // console.log("[DB Query]:", pgText, params);

    return pool.query(pgText, params, (err, res) => {
      if (callback) {
        let result = res ? res.rows : [];
        if (res) {
          // Add MySQL-style properties for compatibility
          result.affectedRows = res.rowCount || 0;
          result.insertId = (res.rows && res.rows[0]) ? res.rows[0].id : null;
        }
        callback(err, result);
      }
    });
  },
  getConnection: (callback) => {
    pool.connect((err, client, done) => {
      if (err) return callback(err);
      
      // Wrap client to match mysql2 connection
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

