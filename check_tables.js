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

pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'", (err, res) => {
  if (err) {
    console.error("Error listing tables:", err.message);
  } else {
    console.log("Tables in database:");
    console.table(res.rows);
  }
  pool.end();
});
