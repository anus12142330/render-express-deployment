import db from './db.js';

async function run() {
    const [rows] = await db.promise().query('SHOW TABLES');
    console.log(rows.map(r => Object.values(r)[0]).filter(t => t.startsWith('ap_') || t.startsWith('ar_')));
    process.exit(0);
}

run();
