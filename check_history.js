import db from './db.js';
(async () => {
    try {
        const [rows] = await db.promise().query("DESCRIBE history");
        console.log("Columns:", rows.map(r => ({ Field: r.Field, Extra: r.Extra })));
        process.exit(0);
    } catch (err) {
        process.exit(1);
    }
})();
