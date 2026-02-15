const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

async function run() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'portal_db'
    });

    try {
        console.log('Running migrations...');
        // Add columns to sales_orders
        await connection.query("ALTER TABLE sales_orders ADD COLUMN delivery_notes TEXT NULL");
        console.log('Added delivery_notes');
        await connection.query("ALTER TABLE sales_orders ADD COLUMN delivered_at DATETIME NULL");
        console.log('Added delivered_at');
        await connection.query("ALTER TABLE sales_orders ADD COLUMN delivered_by BIGINT NULL");
        console.log('Added delivered_by');

        console.log('Migration completed successfully');

    } catch (err) {
        if (err.message.includes('Duplicate column name')) {
            console.log('Columns already exist, skipping.');
        } else {
            console.error('Error:', err.message);
        }
    } finally {
        await connection.end();
    }
}

run();
