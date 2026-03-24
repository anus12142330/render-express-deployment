import db from './db.js';

async function describeMissing() {
    try {
        const tables = ['vendor', 'warehouses', 'products'];
        for (const table of tables) {
            const [cols] = await db.promise().query(`DESCRIBE ${table}`);
            console.log(`--- ${table} ---`);
            console.log(JSON.stringify(cols, null, 2));
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

describeMissing();
