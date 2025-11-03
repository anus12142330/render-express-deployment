// src/db.js
import mysql from "mysql2";

const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "portal_db",
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true, // Return DATE and DATETIME as 'YYYY-MM-DD HH:mm:ss' strings

  // keeps idle connections alive (important on Render)
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

export default db;