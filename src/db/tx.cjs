// server/src/db/tx.cjs
// Transaction helper for MySQL
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

// Ensure process.env is populated when this module is loaded directly by services
dotenv.config();

// Create pool that matches existing db.js config
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'reddiaro_portaldb',
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: 20, // Increased from 10 to handle more concurrent requests
    queueLimit: 0,
    dateStrings: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 60000,

});

/**
 * Execute a function within a database transaction
 * @param {Function} fn - Async function that receives a connection
 * @returns {Promise} Result of fn
 */
async function tx(fn) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

module.exports = { tx, pool };
