// server/src/db/tx.cjs
// Transaction helper for MySQL
const mysql = require('mysql2/promise');

// Create pool that matches existing db.js config
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'portal_db',
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: 10, // Increased from 10 to handle more concurrent requests
    queueLimit: 0,
    dateStrings: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    
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
