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

async function seed() {
  const sql = 'INSERT INTO userdata (owner_id, nic, name, casetype, status) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (owner_id, nic) DO NOTHING';
  
  try {
    await pool.query(sql, [1, 'NIC001', 'John Doe vs State', 'District Court', 'ongoing']);
    await pool.query(sql, [1, 'NIC002', 'Jane Smith vs Bank', 'Magistrate Court', 'ongoing']);
    await pool.query(sql, [1, 'NIC003', 'XYZ Corp vs ABC Ltd', 'District Court', 'closed']);
    await pool.query(sql, [1, 'NIC004', 'Property Dispute', 'Supreme Court', 'ongoing']);
    console.log("Dummy data seeded successfully.");
  } catch (err) {
    console.error("Error seeding data:", err.message);
  } finally {
    await pool.end();
  }
}

seed();
