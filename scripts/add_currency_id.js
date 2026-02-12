
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

const run = async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'portal_db',
        port: Number(process.env.DB_PORT || 3306)
    });

    try {
        const dbName = process.env.DB_NAME || 'portal_db';
        const [columns] = await conn.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sales_orders' AND COLUMN_NAME = 'currency_id'
        `, [dbName]);

        if (columns.length === 0) {
            console.log('Adding currency_id column...');
            await conn.query(`ALTER TABLE sales_orders ADD COLUMN currency_id INT AFTER customer_address`);
            console.log('Column added.');
        } else {
            console.log('Column already exists.');
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await conn.end();
    }
};

run();
