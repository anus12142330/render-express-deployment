const mysql = require('mysql2/promise');
const config = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'reddiaro_portaldb'
};

async function checkDetailed() {
  try {
    const connection = await mysql.createConnection(config);
    console.log('--- Transaction 155 Details ---');
    const [rows] = await connection.query('SELECT *, CHAR_LENGTH(qc_posting_type) as qclength, HEX(qc_posting_type) as qchex FROM inventory_transactions WHERE id = 155');
    console.log(JSON.stringify(rows, null, 2));
    
    console.log('\n--- Inspection 90 Details ---');
    const [inspections] = await connection.query('SELECT decision, status_id FROM qc_inspections WHERE id = 90');
    console.log(JSON.stringify(inspections, null, 2));

    await connection.end();
  } catch (err) {
    console.error(err);
  }
}

checkDetailed();
