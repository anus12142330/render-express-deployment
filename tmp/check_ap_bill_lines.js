import db from '../db.js';

async function checkSchema() {
    try {
        const [rows] = await db.promise().query('DESCRIBE ap_bill_lines');
        console.log('SCHEMA:', JSON.stringify(rows));
    } catch (err) {
        process.exit(1);
    } finally {
        process.exit();
    }
}

checkSchema();
