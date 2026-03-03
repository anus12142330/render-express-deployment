import db from '../db.js';
async function test() {
    const [rows] = await db.promise().query('DESCRIBE vendor');
    console.log(JSON.stringify(rows.map(r => r.Field)));
    process.exit();
}
test();
