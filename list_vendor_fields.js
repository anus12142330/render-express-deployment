import db from './db.js';

(async () => {
    try {
        const [rows] = await db.query('DESCRIBE vendor');
        console.log(JSON.stringify(rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit(0);
    }
})();
