import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Client } = pg;

async function initDatabase() {
  const config = {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "123",
    port: parseInt(process.env.DB_PORT) || 5432,
  };

  // Connect to the default 'postgres' database to create 'userdb'
  const client = new Client({ ...config, database: "postgres" });

  try {
    await client.connect();
    console.log("Connected to PostgreSQL (postgres database)");

    const dbName = process.env.DB_NAME || "userdb";
    
    // Check if database exists
    const res = await client.query(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`);
    
    if (res.rowCount === 0) {
      console.log(`Database '${dbName}' not found. Creating...`);
      await client.query(`CREATE DATABASE ${dbName}`);
      console.log(`Database '${dbName}' created successfully.`);
    } else {
      console.log(`Database '${dbName}' already exists.`);
    }
  } catch (err) {
    console.error("Error during database initialization:", err.message);
    if (err.code === '28P01') {
      console.error("Suggestion: Authentication failed. Please check DB_PASSWORD in .env.");
    } else if (err.code === 'ECONNREFUSED') {
      console.error("Suggestion: Connection refused. Is PostgreSQL running on localhost:5432?");
    }
  } finally {
    await client.end();
  }
}

initDatabase();
