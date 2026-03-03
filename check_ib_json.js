import db from './db.js';

async function run() {
    const [cols] = await db.promise().query('DESCRIBE inventory_batches');
    console.log(JSON.stringify(cols, null, 2));
    process.exit(0);
}

run();
