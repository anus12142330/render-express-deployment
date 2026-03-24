import db from './db.js';

async function run() {
    try {
        const [rows] = await db.promise().query('SELECT * FROM currency');
        console.log(JSON.stringify(rows, null, 2));
    } catch (err) {
        console.error(err);
    }
    process.exit(0);
}

run();
