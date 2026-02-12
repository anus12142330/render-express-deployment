import 'dotenv/config';
import db from '../db.js';

async function run() {
    try {
        console.log('Checking sales_order_items table for tax_id column...');
        const [columns] = await db.promise().query("SHOW COLUMNS FROM sales_order_items LIKE 'tax_id'");

        if (columns.length === 0) {
            console.log('tax_id column missing. Adding it...');
            await db.promise().query("ALTER TABLE sales_order_items ADD COLUMN tax_id INT DEFAULT NULL");
            console.log('tax_id column added successfully.');
        } else {
            console.log('tax_id column already exists.');
        }
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        process.exit();
    }
}

run();
