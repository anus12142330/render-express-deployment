// src/db.js
import mysql from "mysql2";

const db = mysql.createPool({
  host: "localhost", //process.env.DB_HOST || "localhost",
  user: "admin_portaldb", //process.env.DB_USER || "root",
  password: "JvfD6C2CpFcmGvXQHcsZ", //process.env.DB_PASSWORD || "",
  database: "portal_db",  //process.env.DB_NAME || "portal_db",
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
});

export default db;
