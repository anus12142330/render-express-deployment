const mysql = require('mysql2/promise');
const config = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'reddiaro_portaldb'
};

async function check() {
  try {
    const connection = await mysql.createConnection(config);
    console.log('--- Sell & Recheck Entries for Inspection 90 ---');
    const [rechecks] = await connection.query('SELECT * FROM qc_sell_recheck_entries WHERE qc_inspection_id = 90');
    console.log(JSON.stringify(rechecks, null, 2));
    
    console.log('\n--- Stock Batches for Lot 44 ---');
    const [stocks] = await connection.query('SELECT * FROM inventory_stock_batches WHERE batch_id IN (SELECT id FROM inventory_batches WHERE lot_id = 44)');
    // Wait, lot_id in batches? Or batch_id linked to lot...
    // Let's just find by batch_id from the txn 155 (which had batch_id 16)
    const [stocks2] = await connection.query('SELECT * FROM inventory_stock_batches WHERE batch_id = 16');
    console.log(JSON.stringify(stocks2, null, 2));

    await connection.end();
  } catch (err) {
    console.error(err);
  }
}

check();
