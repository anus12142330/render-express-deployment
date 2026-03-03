import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'portal_db',
});

try {
    const [cols] = await conn.query(`SHOW COLUMNS FROM payment_terms LIKE 'due_days'`);
    if (cols.length === 0) {
        await conn.query(`ALTER TABLE payment_terms ADD COLUMN due_days INT DEFAULT 0`);
        console.log('✅ Column due_days added to payment_terms');
    } else {
        console.log('ℹ️  Column due_days already exists in payment_terms');
    }
} catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
} finally {
    await conn.end();
}
