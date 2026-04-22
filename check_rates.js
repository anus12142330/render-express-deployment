import db from './db.js';

async function check() {
  try {
    const [rows] = await db.promise().query("SELECT name, conversion_rate FROM currency");
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
check();
