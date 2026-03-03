
import db from './db.js';
db.query('DESCRIBE ap_bill_lines', (err, rows) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    rows.forEach(r => console.log(r.Field));
    process.exit(0);
});
