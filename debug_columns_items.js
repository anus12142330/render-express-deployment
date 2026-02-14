import db from './db.js';
db.query('DESCRIBE sales_order_items', (err, rows) => {
    if (err) console.error(err);
    else console.log(rows.map(r => r.Field).join('\n'));
    process.exit();
});
