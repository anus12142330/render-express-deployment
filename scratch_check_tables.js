
import db from './db.js';

async function check() {
    try {
        const [rows] = await db.promise().query('SHOW TABLES');
        const tables = rows.map(r => Object.values(r)[0]);
        console.log('Tables:', tables.filter(t => t.includes('user') || t.includes('role')));
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}

check();
