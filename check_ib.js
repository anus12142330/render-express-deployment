import db from './db.js';

async function run() {
    try {
        const [rows] = await db.promise().query('DESCRIBE inventory_batches');
        console.log("Cols: ", rows.map(r => r.Field).join('|'));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

run();
