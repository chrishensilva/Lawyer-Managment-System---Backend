import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '123',
  database: process.env.DB_NAME || 'userdb',
  port: parseInt(process.env.DB_PORT) || 5432,
});

pool.query("SELECT * FROM users", (err, res) => {
  if (err) {
    console.error("Error querying users:", err.message);
  } else {
    console.log("Users in database:", res.rows);
  }
  pool.end();
});
