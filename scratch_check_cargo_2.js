
import db from './db.js';

async function check() {
    try {
        const [rows] = await db.promise().query('SELECT id, return_no, status_id, qc_status_id FROM cargo_returns');
        console.log('Cargo Returns:', rows);
        const [sqc] = await db.promise().query('SELECT id, cargo_return_id, qc_status_id FROM sales_qc');
        console.log('Sales QC:', sqc);
        const [statuses] = await db.promise().query('SELECT id, name FROM status');
        console.log('Statuses:', statuses);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}

check();
