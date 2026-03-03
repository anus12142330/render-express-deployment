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
    // Check if column already exists
    const [cols] = await conn.query(`SHOW COLUMNS FROM vendor_other LIKE 'bill_type'`);
    if (cols.length === 0) {
        await conn.query(`ALTER TABLE vendor_other ADD COLUMN bill_type ENUM('monthly','delivery') NOT NULL DEFAULT 'delivery'`);
        console.log('✅ Column bill_type added to vendor_other');
    } else {
        console.log('ℹ️  Column bill_type already exists in vendor_other');
    }
} catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
} finally {
    await conn.end();
}
