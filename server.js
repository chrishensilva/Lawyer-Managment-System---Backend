import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import multer from "multer";
import fs from "fs";
import crypto from "crypto";
import compression from "compression";
import { db } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Render/Vercel) for secure cookies
const port = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// Encryption configuration
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef'; // Must be 32 chars
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  if (!text) return null;
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (err) {
    console.error("Decryption failed:", err);
    return null;
  }
}

app.use(compression()); // Enable Gzip/Brotli compression for all responses
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://localhost:5176',
      'http://localhost:5177',
      process.env.VITE_FRONTEND_URL
    ];
    if (!origin || allowed.includes(origin) || origin.startsWith('http://localhost:') || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      console.log(`[CORS Blocked] Origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '100mb' })); // Increased limit for document synchronization
app.use(cookieParser());

// Rate limiting for login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login requests per windowMs
  message: { status: 'error', message: "Too many login attempts, please try again after 15 minutes" }
});

// JWT Verification Middleware
const authenticateToken = (req, res, next) => {
  // Check cookie first, fallback to Authorization header
  let token = req.cookies.token;
  
  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  if (!token) return res.status(401).json({ status: 'error', message: 'Access denied' });

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(403).json({ status: 'error', message: 'Invalid token' });
  }
};

// Serve React frontend — always serve dist/ if it exists (production or not)
const distPath = path.join(__dirname, '../dist');
const distExists = fs.existsSync(distPath);
console.log(`[Static] dist path: ${distPath}`);
console.log(`[Static] dist exists: ${distExists}`);
if (distExists) {
  // Use aggressive caching for static assets (js, css, images)
  app.use(express.static(distPath, {
    maxAge: '7d', // 7 day cache for static assets
    immutable: true,
    index: false // Let our catch-all handle /
  }));
}

// --- DATABASE INITIALIZATION (PostgreSQL) ---
const initDB = () => {
  // --- NEW: users table (for all users, including admins) ---
  const createUsersTable = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(50) DEFAULT 'admin',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;
  db.query(createUsersTable, async (err) => {
    if (err) {
      console.error("Error creating users table:", err);
    } else {
      // Seed default admin if table is empty
      db.query("SELECT COUNT(*) as count FROM users", async (err, result) => {
        if (!err && result && result[0] && parseInt(result[0].count) === 0) {
          const adminUsername = process.env.ADMIN_USERNAME || "admin";
          const adminPassword = process.env.ADMIN_PASSWORD || "123";
          const salt = await bcrypt.genSalt(10);
          const hashedPassword = await bcrypt.hash(adminPassword, salt);
          db.query("INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)", 
            [adminUsername, `${adminUsername}@system.local`, hashedPassword, "admin"], (err) => {
              if (err) console.error("Error seeding admin user:", err.message);
              else console.log(`Default admin user created: ${adminUsername}`);
            });
        }
      });
    }
  });

  // Create activity_log table
  const createLogsTable = `
        CREATE TABLE IF NOT EXISTS activity_log (
            id SERIAL PRIMARY KEY,
            owner_id INT,
            username VARCHAR(255) NOT NULL,
            action VARCHAR(255) NOT NULL,
            details TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;
  db.query(createLogsTable, (err) => {
    if (err) console.error("Error creating logs table:", err);
  });

  // Create case_documents table
  const createDocsTable = `
        CREATE TABLE IF NOT EXISTS case_documents (
            id SERIAL PRIMARY KEY,
            owner_id INT,
            user_nic VARCHAR(255) NOT NULL,
            file_name VARCHAR(255) NOT NULL,
            file_path VARCHAR(255) NOT NULL,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;
  db.query(createDocsTable, (err) => {
    if (err) console.error("Error creating docs table:", err);
  });

  // Create user_profiles table
  const createProfilesTable = `
        CREATE TABLE IF NOT EXISTS user_profiles (
            username VARCHAR(255) PRIMARY KEY,
            owner_id INT,
            fullname VARCHAR(255),
            email VARCHAR(255),
            phone VARCHAR(20),
            avatar_url TEXT,
            notifications JSON,
            language VARCHAR(20) DEFAULT 'English'
        )
    `;
  db.query(createProfilesTable, (err) => {
    if (err) console.error("Error creating profiles table:", err);
  });

  // Create app_settings table
  const createSettingsTable = `
        CREATE TABLE IF NOT EXISTS app_settings (
            id SERIAL PRIMARY KEY,
            owner_id INT,
            setting_key VARCHAR(255),
            setting_value TEXT,
            is_encrypted BOOLEAN DEFAULT FALSE,
            UNIQUE (owner_id, setting_key)
        )
    `;
  db.query(createSettingsTable, (err) => {
    if (err) console.error("Error creating settings table:", err);
  });

  // Create login_history table
  const createLoginHistoryTable = `
        CREATE TABLE IF NOT EXISTS login_history (
            id SERIAL PRIMARY KEY,
            owner_id INT,
            username VARCHAR(255) NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ip_address VARCHAR(45),
            device_type TEXT
        )
    `;
  db.query(createLoginHistoryTable, (err) => {
    if (err) console.error("Error creating login history table:", err);
  });

  // Create todo table
  const createTodoTable = `
        CREATE TABLE IF NOT EXISTS todo (
            id SERIAL PRIMARY KEY,
            owner_id INT,
            task TEXT NOT NULL,
            date DATE,
            time TIME
        )
    `;
  db.query(createTodoTable, (err) => {
    if (err) console.error("Error creating todo table:", err);
  });

  // Create lawyerdata table
  const createLawyersTable = `
        CREATE TABLE IF NOT EXISTS lawyerdata (
            owner_id INT NOT NULL,
            nic VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255),
            contact VARCHAR(20),
            note TEXT,
            PRIMARY KEY (owner_id, nic)
        )
    `;
  db.query(createLawyersTable, (err) => {
    if (err) console.error("Error creating lawyers table:", err);
  });

  // Create userdata table (Clients/Cases)
  const createUsersDataTable = `
        CREATE TABLE IF NOT EXISTS userdata (
            owner_id INT NOT NULL,
            nic VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255),
            number VARCHAR(20),
            address TEXT,
            lawyer1 VARCHAR(255),
            lawyer2 VARCHAR(255),
            lawyer3 VARCHAR(255),
            last_date VARCHAR(255),
            next_date VARCHAR(255),
            note TEXT,
            casetype VARCHAR(255),
            status VARCHAR(50) DEFAULT 'ongoing',
            PRIMARY KEY (owner_id, nic)
        )
    `;
  db.query(createUsersDataTable, (err) => {
    if (err) console.error("Error creating userdata table:", err);
    else {
      // Auto-migrate to add new columns if they don't exist
      const alterQueries = [
        "ALTER TABLE userdata ADD COLUMN IF NOT EXISTS address TEXT",
        "ALTER TABLE userdata ADD COLUMN IF NOT EXISTS lawyer1 VARCHAR(255)",
        "ALTER TABLE userdata ADD COLUMN IF NOT EXISTS lawyer2 VARCHAR(255)",
        "ALTER TABLE userdata ADD COLUMN IF NOT EXISTS lawyer3 VARCHAR(255)",
        "ALTER TABLE userdata ADD COLUMN IF NOT EXISTS casetype VARCHAR(255)"
      ];
      alterQueries.forEach(query => {
        db.query(query, (err) => {
          if (err) {
            console.error("Migration error for userdata:", err.message);
          }
        });
      });

    }
  });

  // Create case_assignments table
  const createAssignmentsTable = `
        CREATE TABLE IF NOT EXISTS case_assignments (
            owner_id INT NOT NULL,
            user_nic VARCHAR(255) NOT NULL,
            lawyer_name VARCHAR(255) NOT NULL,
            assigned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (owner_id, user_nic, lawyer_name)
        )
    `;
  db.query(createAssignmentsTable, (err) => {
    if (err) console.error("Error creating assignments table:", err);
  });

  // Create subscriptions table
  const createSubsTable = `
        CREATE TABLE IF NOT EXISTS subscriptions (
            owner_id INT PRIMARY KEY,
            plan_name VARCHAR(255) DEFAULT 'Professional',
            renewal_date DATE,
            status VARCHAR(50) DEFAULT 'Active'
        )
    `;
  db.query(createSubsTable, (err) => {
    if (err) console.error("Error creating subscriptions table:", err);
  });

  // --- MIGRATION LOGIC FOR EXISTING TABLES ---
  const tablesToFix = [
    { name: 'userdata', pk: ['owner_id', 'nic'] },
    { name: 'lawyerdata', pk: ['owner_id', 'nic'] }
  ];

  tablesToFix.forEach(table => {
    // 1. Ensure owner_id column exists
    db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table.name}' AND column_name = 'owner_id'`, (err, results) => {
      if (!err && results.length === 0) {
        db.query(`ALTER TABLE ${table.name} ADD COLUMN owner_id INT NOT NULL`, (err) => {
           if (!err) {
             // 2. Resolve primary key conflict
             db.query(`ALTER TABLE ${table.name} DROP CONSTRAINT IF EXISTS ${table.name}_pkey`, (err) => {
                db.query(`ALTER TABLE ${table.name} ADD PRIMARY KEY (${table.pk.join(',')})`, (err) => {
                  if (err) console.error(`Failed to update PK for ${table.name}:`, err.message);
                });
             });
           }
        });
      }
    });
  });

  // General check for owner_id in other tables
  const otherTables = ['todo', 'activity_log', 'login_history', 'app_settings', 'case_documents', 'user_profiles', 'editors'];
  otherTables.forEach(table => {
    db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' AND column_name = 'owner_id'`, (err, results) => {
      if (!err && results.length === 0) {
        db.query(`ALTER TABLE ${table} ADD COLUMN owner_id INT`);
      }
      
      if (table === 'app_settings') {
        db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'id'`, (err, idResults) => {
          if (!err && idResults.length === 0) {
             db.query(`ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey`, (err) => {
                 db.query(`ALTER TABLE app_settings ADD COLUMN id SERIAL PRIMARY KEY`, (err) => {
                    db.query(`ALTER TABLE app_settings ADD CONSTRAINT unique_owner_setting UNIQUE (owner_id, setting_key)`, (err) => {
                        if (err) console.error("Failed to migrate app_settings unique key:", err.message);
                        else console.log("Migrated app_settings schema successfully.");
                    });
                 });
             });
          }
        });
      }
    });
  });


  // Create editors table (sub-users per account with permissions)
  db.query(`
    CREATE TABLE IF NOT EXISTS editors (
      id SERIAL PRIMARY KEY,
      owner_id INT NOT NULL,
      username VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL,
      permissions JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner_id, username)
    )
  `, (err) => {
    if (err) console.error("Error creating editors table:", err.message);
  });
};

initDB();

// Check database connection on startup
db.getConnection((err, connection) => {
  if (err) {
    console.error("CRITICAL: Database connection failed!");
    console.error("Error code:", err.code);
    console.error("Error message:", err.message);
    console.error("Full error:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
    if (err.code === 'ENOTFOUND') {
      console.error("Suggestion: The database host could not be resolved. Check DB_HOST.");
    } else if (err.code === 'ECONNREFUSED') {
      console.error("Suggestion: Connection refused. Check DB_PORT and that DB server is running.");
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error("Suggestion: Wrong DB_USER or DB_PASSWORD.");
    } else if (err.code === 'HANDSHAKE_NO_SSL_SUPPORT') {
      console.error("Suggestion: Server doesn't support SSL. Try setting ssl: undefined.");
    }
  } else {
    console.log("Database connection successful!");
    connection.release();
  }
});

// --- HELPER: Log Activity ---
const logActivity = (username, action, details, extra = {}) => {
  const owner_id = extra.userId || null;
  const sql = "INSERT INTO activity_log (owner_id, username, action, details) VALUES (?, ?, ?, ?)";
  db.query(sql, [owner_id, username, action, typeof details === 'object' ? JSON.stringify(details) : details], (err) => {
    if (err) console.error("Logging failed:", err);
  });

  if (action === 'Login' && extra.req) {
    const ip = extra.req.ip || extra.req.headers['x-forwarded-for'] || extra.req.socket.remoteAddress;
    const device = extra.req.headers['user-agent'];
    const historySql = "INSERT INTO login_history (owner_id, username, ip_address, device_type) VALUES (?, ?, ?, ?)";
    db.query(historySql, [owner_id, username, ip, device], (err) => {
      if (err) console.error("Login history logging failed:", err);
    });
  }
};

// --- HELPER: Get Dynamic Email Transporter (returns null if SMTP not configured) ---
const getDynamicTransporter = async (userId) => {
  return new Promise((resolve) => {
    db.query('SELECT setting_key, setting_value, is_encrypted FROM app_settings WHERE owner_id = ? AND setting_key IN (?, ?)', [userId, 'smtp_email', 'smtp_password'], (err, results) => {
      if (err || results.length < 2) {
        // No SMTP configured for this user — resolve null to skip email silently
        resolve(null);
      } else {
        const settings = {};
        results.forEach(r => {
          settings[r.setting_key] = r.is_encrypted ? decrypt(r.setting_value) : r.setting_value;
        });
        if (!settings.smtp_email || !settings.smtp_password) {
          resolve(null);
        } else {
          resolve(nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false, // TLS
            auth: { user: settings.smtp_email, pass: settings.smtp_password },
            connectionTimeout: 15000, // 15s
            greetingTimeout: 15000,
            family: 4 // Force IPv4 — Render free tier blocks IPv6 outbound
          }));
        }
      }
    });
  });
};

// --- HELPER: Send Email ---
async function sendAssignmentEmail(lawyerEmail, lawyerName, user, caseNIC, userId) {
  const transporter = await getDynamicTransporter(userId);
  if (!transporter) {
    console.log(`[Email] Skipped: No SMTP configured for user ${userId}. Set up SMTP in My Account.`);
    return { success: false, error: 'No SMTP configured' };
  }
  if (!lawyerEmail) {
    return { success: false, error: 'Lawyer has no email address' };
  }
  const mailOptions = {
    from: transporter.options.auth.user,
    to: lawyerEmail,
    subject: `New Case Assigned: ${caseNIC}`,
    text: `Dear ${lawyerName},\r\n\r\nYou have been assigned a new case in the Court Case Management System.\r\n\r\nCLIENT DETAILS:\r\n- Name: ${user.name}\r\n- NIC: ${caseNIC}\r\n- Email: ${user.email}\r\n- Contact: ${user.number}\r\n\r\nCASE SCHEDULE:\r\n- Last Date: ${user.last_date}\r\n- Next Date: ${user.next_date}\r\n- Current Status: ${user.status || 'Ongoing'}\r\n\r\nNOTES:\r\n${user.note || 'No specific notes provided.'}\r\n\r\nThis is an automated notification. Please do not reply to this email.\r\n\r\nBest Regards,\r\nCourt Record Management System`
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Success: Assignment email sent to ${lawyerEmail}`);
    return { success: true };
  } catch (error) {
    console.error('Email send failed:', error);
    return { success: false, error: error.message };
  }
}

// --- Multer Setup for File Uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, './uploads');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Image files are allowed'), false);
    }
  }
});

// Memory-based multer for avatar uploads (stored as Base64 in database)
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max for profile pictures
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for avatars'), false);
    }
  }
});

app.use('/uploads', express.static(path.join(__dirname, './uploads')));

// --- API ROUTES ---

// Get all lawyers
app.get('/api/getLawyers', authenticateToken, (req, res) => {
  const search = req.query.search || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const userId = req.user.userId;

  const countSql = 'SELECT COUNT(*) as total FROM lawyerdata WHERE owner_id = ? AND (nic LIKE ? OR name LIKE ?)';
  db.query(countSql, [userId, `%${search}%`, `%${search}%`], (err, countResults) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    const total = countResults[0].total;

    const sql = 'SELECT * FROM lawyerdata WHERE owner_id = ? AND (nic LIKE ? OR name LIKE ?) LIMIT ? OFFSET ?';
    db.query(sql, [userId, `%${search}%`, `%${search}%`, limit, offset], (err, data) => {
      if (err) return res.status(500).json({ status: 'error', message: err.message });
      res.json({
        data,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit)
        }
      });
    });
  });
});

// Get users (simple list) - These are actually the clients/cases
app.get('/api/getUsers', authenticateToken, (req, res) => {
  const search = req.query.search || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const userId = req.user.userId;

  const countSql = 'SELECT COUNT(*) as total FROM userdata WHERE owner_id = ? AND (nic LIKE ? OR name LIKE ?)';
  db.query(countSql, [userId, `%${search}%`, `%${search}%`], (err, countResults) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    const total = countResults[0].total;

    const sql = 'SELECT * FROM userdata WHERE owner_id = ? AND (nic LIKE ? OR name LIKE ?) LIMIT ? OFFSET ?';
    db.query(sql, [userId, `%${search}%`, `%${search}%`, limit, offset], (err, data) => {
      if (err) return res.status(500).json({ status: 'error', message: err.message });
      res.json({
        data,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit)
        }
      });
    });
  });
});

// Get user cases (with assignments)
app.get('/api/getUserCases', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const sql = `
        SELECT u.*, a.lawyer_name AS assigned_lawyer 
        FROM userdata u
        LEFT JOIN case_assignments a ON u.nic = a.user_nic AND u.owner_id = a.owner_id
        WHERE u.owner_id = ?
        ORDER BY u.next_date ASC
    `;
  db.query(sql, [userId], (err, data) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json(data);
  });
});

// Assign lawyer
app.post('/api/assignLawyer', authenticateToken, async (req, res) => {
  const { nic, lawyer, sendEmail } = req.body;
  const userId = req.user.userId;
  if (!nic || !lawyer) return res.json({ status: 'error', message: 'NIC or lawyer missing' });

  const sql = 'INSERT INTO case_assignments (owner_id, user_nic, lawyer_name, assigned_date) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id, user_nic, lawyer_name) DO UPDATE SET lawyer_name = EXCLUDED.lawyer_name, assigned_date = EXCLUDED.assigned_date';
  db.query(sql, [userId, nic, lawyer, new Date().toISOString().slice(0, 19).replace('T', ' ')], async (err) => {
    if (err) return res.json({ status: 'error', message: err.message });

    let emailSent = false;
    let emailMessage = '';

    if (sendEmail) {
      // Fetch lawyer email and user info
      try {
        const lawyers = await new Promise((resolve, reject) => {
          db.query('SELECT * FROM lawyerdata WHERE name = ? AND owner_id = ?', [lawyer, userId], (err, res) => err ? reject(err) : resolve(res));
        });
        
        if (lawyers.length > 0) {
          const users = await new Promise((resolve, reject) => {
            db.query('SELECT * FROM userdata WHERE nic = ? AND owner_id = ?', [nic, userId], (err, res) => err ? reject(err) : resolve(res));
          });
          
          if (users.length > 0) {
            const emailResult = await sendAssignmentEmail(lawyers[0].email, lawyer, users[0], nic, userId);
            if (!emailResult.success) {
              emailMessage = ` (Email not sent: ${emailResult.error})`;
            }
          }
        }
      } catch (e) {
        console.error("Error during email assignment fetch:", e);
        emailMessage = ' (Failed to fetch email data)';
      }
    }

    logActivity(req.user.username, 'Lawyer Assignment', `Assigned ${lawyer} to case ${nic}`, { userId: req.user.userId });
    res.json({ status: 'success', message: `Assignment successful${emailMessage}` });
  });
});

// Add lawyer
app.post('/api/addLawyer', authenticateToken, (req, res) => {
  const { nic, name, email, contact, note } = req.body;
  const userId = req.user.userId;
  const sql = 'INSERT INTO lawyerdata (owner_id, nic, name, email, contact, note) VALUES (?, ?, ?, ?, ?, ?)';
  db.query(sql, [userId, nic, name, email, contact, note], (err) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    logActivity(req.user.username, 'Add Lawyer', `Added lawyer: ${name} (${nic})`, { userId: req.user.userId });
    res.json({ status: 'success' });
  });
});

// Delete lawyer
app.post('/api/deleteLawyer', authenticateToken, (req, res) => {
  const { nic } = req.body;
  const userId = req.user.userId;
  db.query('DELETE FROM lawyerdata WHERE nic = ? AND owner_id = ?', [nic, userId], (err) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    logActivity(req.user.username, 'Delete Lawyer', `Deleted lawyer: ${nic}`, { userId: req.user.userId });
    res.json({ status: 'success' });
  });
});

// Update lawyer
app.post('/api/updateLawyer', authenticateToken, (req, res) => {
  const { nic, name, email, contact, note } = req.body;
  const userId = req.user.userId;
  const sql = 'UPDATE lawyerdata SET name=?, email=?, contact=?, note=? WHERE nic=? AND owner_id=?';
  db.query(sql, [name, email, contact, note, nic, userId], (err) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    logActivity(req.user.username, 'Update Lawyer', `Updated lawyer: ${name} (${nic})`, { userId: req.user.userId });
    res.json({ status: 'success' });
  });
});

// Add user (Client/Case)
app.post('/api/addUser', authenticateToken, (req, res) => {
  const { name, nic, email, number, address, lawyer1, lawyer2, lawyer3, last_date, next_date, note, casetype } = req.body;
  const userId = req.user.userId;
  const sql = 'INSERT INTO userdata (owner_id, name, nic, email, number, address, lawyer1, lawyer2, lawyer3, last_date, next_date, note, casetype) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING nic';
  db.query(sql, [userId, name, nic, email, number, address || null, lawyer1 || null, lawyer2 || null, lawyer3 || null, last_date, next_date, note, casetype || null], (err) => {
    if (err) return res.json({ status: 'error', message: err.message });
    logActivity(req.user.username, 'Add Client', `Created new case for: ${name} (${nic})`, { userId: req.user.userId });
    res.json({ status: 'success' });
  });
});

// Delete user (Client/Case)
app.post('/api/deleteUser', authenticateToken, (req, res) => {
  const { nic } = req.body;
  const userId = req.user.userId;
  db.query('DELETE FROM userdata WHERE nic = ? AND owner_id = ?', [nic, userId], (err) => {
    if (err) return res.json({ status: 'error', message: err.message });
    db.query('DELETE FROM case_assignments WHERE user_nic = ? AND owner_id = ?', [nic, userId], () => {
      logActivity(req.user.username, 'Delete Client', `Removed case file: ${nic}`, { userId: req.user.userId });
      res.json({ status: 'success' });
    });
  });
});

// Update user (Client/Case)
app.post('/api/updateUser', authenticateToken, (req, res) => {
  const { name, nic, email, number, address, lawyer1, lawyer2, lawyer3, last_date, next_date, note, casetype, status } = req.body;
  const userId = req.user.userId;
  const sql = 'UPDATE userdata SET name=?, email=?, number=?, address=?, lawyer1=?, lawyer2=?, lawyer3=?, last_date=?, next_date=?, note=?, casetype=?, status=? WHERE nic=? AND owner_id=?';
  db.query(sql, [name, email, number, address || null, lawyer1 || null, lawyer2 || null, lawyer3 || null, last_date, next_date, note, casetype, status || 'ongoing', nic, userId], (err) => {
    if (err) return res.json({ status: 'error', message: err.message });
    logActivity(req.user.username, 'Update Client', `Updated case details for: ${nic}`, { userId: req.user.userId });
    res.json({ status: 'success' });
  });
});

// Update status
app.post('/api/updateStatus', authenticateToken, (req, res) => {
  const { nic, status } = req.body;
  const userId = req.user.userId;
  const sql = 'UPDATE userdata SET status = ? WHERE nic = ? AND owner_id = ?';
  db.query(sql, [status, nic, userId], (err) => {
    if (err) return res.json({ status: 'error', message: err.message });
    res.json({ status: 'success' });
  });
});

// Todos
app.get('/api/getTodos', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  db.query('SELECT * FROM todo WHERE owner_id = ? ORDER BY date ASC, time ASC', [userId], (err, data) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json(data);
  });
});

app.post('/api/addTodo', authenticateToken, (req, res) => {
  const { task, date, time } = req.body;
  const userId = req.user.userId;
  db.query('INSERT INTO todo (owner_id, task, date, time) VALUES (?, ?, ?, ?)', [userId, task, date, time], (err) => {
    if (err) return res.json({ status: 'error', message: err.message });
    res.json({ status: 'success' });
  });
});

app.post('/api/deleteTodo', authenticateToken, (req, res) => {
  const { id } = req.body;
  const userId = req.user.userId;
  db.query('DELETE FROM todo WHERE id = ? AND owner_id = ?', [id, userId], (err) => {
    if (err) return res.json({ status: 'error', message: err.message });
    res.json({ status: 'success' });
  });
});

// Stats & Dashboard
app.get('/api/dashboard_counts', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const sql = `
        SELECT 
            (SELECT COUNT(*) FROM userdata WHERE owner_id = ?) as totalClients,
            (SELECT COUNT(*) FROM lawyerdata WHERE owner_id = ?) as totalLawyers,
            (SELECT COUNT(*) FROM userdata WHERE owner_id = ?) as totalCases
    `;
  db.query(sql, [userId, userId, userId], (err, results) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json({
      totalClients: results[0].totalClients,
      totalLawyers: results[0].totalLawyers,
      totalCases: results[0].totalCases
    });
  });
});

app.get('/api/getCaseStats', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const sql = 'SELECT casetype AS name, COUNT(*) AS value FROM userdata WHERE owner_id = ? GROUP BY casetype';
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    const stats = results.map(row => ({
      name: row.name ? (row.name.charAt(0).toUpperCase() + row.name.slice(1)) : 'General',
      value: parseInt(row.value) || 0
    }));
    res.json(stats);
  });
});

app.get('/api/getReportData', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  db.query('SELECT * FROM userdata WHERE owner_id = ? ORDER BY next_date ASC', [userId], (err, data) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json(data);
  });
});

// Editors Management
app.get('/api/getEditors', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  db.query('SELECT id, username, permissions FROM editors WHERE owner_id = ?', [userId], (err, data) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json(data);
  });
});

app.post('/api/addEditor', authenticateToken, async (req, res) => {
  const { username, password, permissions } = req.body;
  const userId = req.user.userId;
  if (!username || !password) return res.json({ status: 'error', message: 'Username and password are required' });

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const permissionsJson = JSON.stringify(permissions || []);

    db.query('INSERT INTO editors (owner_id, username, password, permissions) VALUES (?, ?, ?, ?)',
      [userId, username, hashedPassword, permissionsJson],
      (err) => {
        if (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            return res.json({ status: 'error', message: 'An editor with that username already exists.' });
          }
          return res.status(500).json({ status: 'error', message: err.message });
        }
        logActivity(req.user.username, 'Add Editor', `Created editor account: ${username}`, { userId });
        res.json({ status: 'success' });
      }
    );
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Failed to create editor' });
  }
});

app.post('/api/deleteEditor', authenticateToken, (req, res) => {
  const { id } = req.body;
  const userId = req.user.userId;
  db.query('DELETE FROM editors WHERE id = ? AND owner_id = ?', [id, userId], (err) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    logActivity(req.user.username, 'Delete Editor', `Removed editor ID: ${id}`, { userId });
    res.json({ status: 'success' });
  });
});

// --- AUTHENTICATION ---

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ status: 'error', message: 'All fields are required' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const checkSql = 'SELECT username, email FROM users WHERE username = ? OR email = ?';
    db.query(checkSql, [username, email], (err, results) => {
      if (err) return res.status(500).json({ status: 'error', message: err.message });
      if (results.length > 0) {
        const usernameTaken = results.some(r => r.username === username);
        const emailTaken = results.some(r => r.email === email);
        if (usernameTaken && emailTaken) {
          return res.status(400).json({ status: 'error', message: 'Username and email are already in use' });
        } else if (usernameTaken) {
          return res.status(400).json({ status: 'error', message: 'Username is already taken. Please choose a different one.' });
        } else {
          return res.status(400).json({ status: 'error', message: 'An account with this email already exists. Try logging in instead.' });
        }
      }

      const insertSql = 'INSERT INTO users (username, email, password) VALUES (?, ?, ?) RETURNING id';
      db.query(insertSql, [username, email, hashedPassword], (err, result) => {
        if (err) return res.status(500).json({ status: 'error', message: err.message });

        const userId = result.insertId;
        const user = { userId, username, role: 'admin' };
        const expiry = process.env.JWT_EXPIRY || '24h';
        const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: expiry });

        res.cookie('token', token, {
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          path: '/',
          maxAge: 24 * 60 * 60 * 1000
        });

        // Initialize default profile
        db.query('INSERT INTO user_profiles (username, owner_id, email) VALUES (?, ?, ?)', [username, userId, email]);
        
        // Initialize default subscription
        db.query("INSERT INTO subscriptions (owner_id, renewal_date) VALUES (?, CURRENT_DATE + INTERVAL '30 days')", [userId]);

        logActivity(username, 'Registration', 'New user registered', { userId });
        res.json({ status: 'success', user, token });
      });
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const handleSuccessfulLogin = (user) => {
    const expiry = process.env.JWT_EXPIRY || '24h';
    const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: expiry });
    const cookieOptions = {
      httpOnly: true,
      secure: true, // Always secure for cross-site
      sameSite: 'none', // Required for cross-site (Vercel to Render)
      path: '/',
      maxAge: 24 * 60 * 60 * 1000
    };
    
    res.cookie('token', token, cookieOptions);
    const logId = user.role === 'admin' ? user.userId : user.owner_id;
    logActivity(user.username, 'Login', 'User logged in', { req, userId: logId });
    res.json({ status: 'success', user, token });
  };

  db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    
    if (results.length > 0) {
      // Main user (admin)
      const userInDb = results[0];
      const validPassword = await bcrypt.compare(password, userInDb.password);
      if (!validPassword) return res.json({ status: 'error', message: 'Invalid credentials' });

      handleSuccessfulLogin({
        userId: userInDb.id,
        username: userInDb.username,
        role: userInDb.role
      });
    } else {
      // Sub-user (editor)
      db.query('SELECT * FROM editors WHERE username = ?', [username], async (err, editorResults) => {
        if (err) return res.status(500).json({ status: 'error', message: err.message });
        if (editorResults.length === 0) return res.json({ status: 'error', message: 'Invalid credentials' });

        const editorInDb = editorResults[0];
        const validPassword = await bcrypt.compare(password, editorInDb.password);
        if (!validPassword) return res.json({ status: 'error', message: 'Invalid credentials' });

        let parsedPermissions = [];
        try {
          parsedPermissions = typeof editorInDb.permissions === 'string' ? JSON.parse(editorInDb.permissions) : editorInDb.permissions;
        } catch (e) {
          console.error("Failed to parse permissions", e);
        }

        handleSuccessfulLogin({
          userId: editorInDb.owner_id, // They operate on their admin's data
          owner_id: editorInDb.owner_id,
          username: editorInDb.username,
          role: 'editor',
          permissions: parsedPermissions || []
        });
      });
    }
  });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: true,
    sameSite: 'none'
  });
  res.json({ status: 'success' });
});

app.get('/api/verifyToken', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(200).json({ status: 'error', message: 'No session' });

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ status: 'success', user: verified });
  } catch (err) {
    res.status(200).json({ status: 'error', message: 'Invalid token' });
  }
});

app.post('/api/uploadDocument', authenticateToken, upload.single('file'), (req, res) => {
  const { nic } = req.body;
  const file = req.file;
  const userId = req.user.userId;

  if (!nic || !file) return res.json({ status: 'error', message: 'NIC or file missing' });

  const sql = 'INSERT INTO case_documents (owner_id, user_nic, file_name, file_path) VALUES (?, ?, ?, ?)';
  db.query(sql, [userId, nic, file.originalname, `/uploads/${file.filename}`], (err) => {
    if (err) return res.json({ status: 'error', message: err.message });
    res.json({ status: 'success', message: 'Document uploaded successfully' });
  });
});

app.get('/api/getDocuments/:nic', authenticateToken, (req, res) => {
  const { nic } = req.params;
  const userId = req.user.userId;
  const sql = 'SELECT * FROM case_documents WHERE user_nic = ? AND owner_id = ?';
  db.query(sql, [nic, userId], (err, data) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json(data);
  });
});

app.post('/api/deleteDocument', authenticateToken, (req, res) => {
  const { id, path: filePath } = req.body;
  const userId = req.user.userId;
  const sql = 'DELETE FROM case_documents WHERE id = ? AND owner_id = ?';
  db.query(sql, [id, userId], (err) => {
    if (err) return res.json({ status: 'error', message: err.message });

    // Optional: Delete physical file
    const fullPath = path.join(__dirname, './', filePath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

    res.json({ status: 'success' });
  });
});

app.get('/api/getActivityLogs', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const sql = `
    SELECT l.*, p.avatar_url 
    FROM activity_log l 
    LEFT JOIN user_profiles p ON l.username = p.username AND l.owner_id = p.owner_id
    WHERE l.owner_id = ?
    ORDER BY l.timestamp DESC LIMIT 500
  `;
  db.query(sql, [userId], (err, data) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json(data);
  });
});

app.post('/api/logAction', authenticateToken, (req, res) => {
  const { username, action, details } = req.body;
  logActivity(username, action, details, { userId: req.user.userId });
  res.json({ status: 'success' });
});

// --- ACCOUNT MANAGEMENT ROUTES ---

// Get Profile
app.get('/api/getProfile', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const sql = 'SELECT * FROM user_profiles WHERE owner_id = ?';
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    if (results.length > 0) {
      res.json(results[0]);
    } else {
      // Return default profile if not exists
      res.json({
        username: req.user.username,
        fullname: '',
        email: '',
        phone: '',
        avatar_url: null,
        notifications: JSON.stringify({ caseAssigned: true, reminder: true }),
        language: 'English'
      });
    }
  });
});

// Update Profile
app.post('/api/updateProfile', authenticateToken, (req, res) => {
  const { fullname, email, phone, avatar_url } = req.body;
  const userId = req.user.userId;
  const sql = `
    INSERT INTO user_profiles (username, owner_id, fullname, email, phone, avatar_url) 
    VALUES (?, ?, ?, ?, ?, ?) 
    ON CONFLICT (username) DO UPDATE SET fullname = EXCLUDED.fullname, email = EXCLUDED.email, phone = EXCLUDED.phone, avatar_url = EXCLUDED.avatar_url
  `;
  db.query(sql, [req.user.username, userId, fullname, email, phone, avatar_url], (err) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    logActivity(req.user.username, 'Profile Update', 'User updated their personal profile', { userId });
    res.json({ status: 'success' });
  });
});

// Change Password
app.post('/api/changePassword', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.userId;

  db.query('SELECT password FROM users WHERE id = ?', [userId], async (err, results) => {
    if (err || results.length === 0) return res.status(500).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, results[0].password);
    if (!valid) return res.json({ status: 'error', message: 'Current password incorrect' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    db.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId], (err) => {
      if (err) return res.status(500).json({ status: 'error', message: err.message });
      logActivity(req.user.username, 'Password Change', 'User changed their account password', { userId });
      res.json({ status: 'success' });
    });
  });
});

// Get Login Activity (Last 5)
app.get('/api/getLoginActivity', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const sql = 'SELECT * FROM login_history WHERE owner_id = ? ORDER BY timestamp DESC LIMIT 5';
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json(results);
  });
});

// SMTP Configuration
app.get('/api/getSMTP', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  db.query('SELECT * FROM app_settings WHERE owner_id = ? AND setting_key IN (?, ?)', [userId, 'smtp_email', 'smtp_password'], (err, results) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });

    const settings = {};
    results.forEach(r => {
      settings[r.setting_key] = r.is_encrypted ? decrypt(r.setting_value) : r.setting_value;
    });

    res.json({
      email: settings.smtp_email || '',
      password: settings.smtp_password ? '********' : ''
    });
  });
});

app.post('/api/updateSMTP', authenticateToken, (req, res) => {
  const { email, password } = req.body;
  const userId = req.user.userId;
  const encryptedPassword = encrypt(password);

  const queries = [
    { sql: 'INSERT INTO app_settings (owner_id, setting_key, setting_value, is_encrypted) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value', params: [userId, 'smtp_email', email, false] }
  ];

  if (password && password !== '********') {
    queries.push({ sql: 'INSERT INTO app_settings (owner_id, setting_key, setting_value, is_encrypted) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value', params: [userId, 'smtp_password', encryptedPassword, true] });
  }


  let count = 0;
  let hasError = false;
  queries.forEach(q => {
    db.query(q.sql, q.params, (err) => {
      count++;
      if (err) hasError = true;
      if (count === queries.length) {
        if (hasError) return res.status(500).json({ status: 'error' });
        logActivity(req.user.username, 'SMTP Update', 'Updated SMTP settings', { userId });
        res.json({ status: 'success' });
      }
    });
  });
});

// Test SMTP
app.post('/api/testSMTP', authenticateToken, async (req, res) => {
  const { email, password } = req.body;
  const userId = req.user.userId;
  let testPassword = password;

  if (password === '********') {
    const result = await new Promise((resolve) => {
      db.query("SELECT setting_value FROM app_settings WHERE owner_id = ? AND setting_key = ?", [userId, 'smtp_password'], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ status: 'error', message: 'No SMTP password configured for connection test' });
        resolve(decrypt(results[0].setting_value));
      });
    });
    testPassword = result;
  }

  if (!email || !testPassword) return res.json({ status: 'error', message: 'Missing credentials' });

  const testTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // TLS
    auth: { user: email, pass: testPassword },
    connectionTimeout: 15000, // 15s
    greetingTimeout: 15000,
    family: 4 // Force IPv4 — Render free tier blocks IPv6 outbound
  });

  try {
    await testTransporter.verify();
    console.log(`[SMTP] Test Success for user ${userId}`);
    res.json({ status: 'success' });
  } catch (err) {
    console.error(`[SMTP] Test Failed for user ${userId}:`, err.message);
    res.json({ status: 'error', message: `Server test failed: ${err.message}` });
  }
});

// Subscription Info
app.get('/api/getSubscription', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  db.query('SELECT * FROM subscriptions WHERE owner_id = ? LIMIT 1', [userId], (err, results) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    if (results.length > 0) {
      res.json(results[0]);
    } else {
      res.json({ plan_name: 'Professional', renewal_date: 'N/A', status: 'Trial' });
    }
  });
});

// Update Preferences
app.post('/api/updatePreferences', authenticateToken, (req, res) => {
  const { notifications, language } = req.body;
  const userId = req.user.userId;
  const sql = `
    INSERT INTO user_profiles (username, owner_id, notifications, language) 
    VALUES (?, ?, ?, ?) 
    ON CONFLICT (username) DO UPDATE SET notifications = EXCLUDED.notifications, language = EXCLUDED.language
  `;
  db.query(sql, [req.user.username, userId, JSON.stringify(notifications), language], (err) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json({ status: 'success' });
  });
});

app.post('/api/uploadAvatar', authenticateToken, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.json({ status: 'error', message: 'No file uploaded' });
  const userId = req.user.userId;
  const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

  const sql = `
    INSERT INTO user_profiles (username, owner_id, avatar_url) 
    VALUES (?, ?, ?) 
    ON CONFLICT (username) DO UPDATE SET avatar_url = EXCLUDED.avatar_url
  `;

  db.query(sql, [req.user.username, userId, base64Image], (err) => {
    if (err) return res.status(500).json({ status: 'error', message: err.message });
    res.json({ status: 'success', avatar_url: base64Image });
  });
});

// Catch-all: serve React app for any non-API route
if (distExists) {
  app.get('/{*path}', (req, res) => {
    // Only catch-all if it's not an API call
    if (!req.path.startsWith('/api')) {
      const indexPath = path.join(distPath, 'index.html');
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: 'API route not found' });
    }
  });
}

app.use((err, req, res, next) => {
  console.error("[Fatal Error]:", err);
  res.status(500).json({ status: 'error', message: 'Internal Server Error', detail: err.message });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
