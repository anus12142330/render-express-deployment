import db from './db.js';

async function check() {
  try {
    const [rows] = await db.promise().query("DESCRIBE sales_orders");
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
check();
