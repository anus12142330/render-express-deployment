import mysql from 'mysql2';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'reddiaro_portaldb',
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    dateStrings: true,
    multipleStatements: true
});

export default pool;
