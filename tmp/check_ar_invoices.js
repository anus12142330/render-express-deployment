const fs = require('fs');
const db = require('../db.js').default;

async function run() {
    try {
        const [rows] = await db.promise().query('DESCRIBE ar_invoices');
        fs.writeFileSync('ar_invoices_table.json', JSON.stringify(rows));
    } catch (err) {
        console.error(err.message);
    }
    process.exit();
}
run();
