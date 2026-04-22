import db from './db.js';

async function check() {
  try {
    const [rows] = await db.promise().query("SELECT key_name FROM menu_module WHERE key_name LIKE 'Sales%' OR key_name LIKE 'Dispatch%'");
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
check();
