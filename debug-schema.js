import db from './db.js';
async function run() {
    try {
        const [rows] = await db.promise().query('DESCRIBE proforma_invoice');
        console.log(JSON.stringify(rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}
run();
