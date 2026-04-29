const mysql = require('mysql2/promise');
const config = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'reddiaro_portaldb'
};

async function debugInspection() {
  try {
    const connection = await mysql.createConnection(config);
    
    console.log('--- Inspection 90 Details ---');
    const [inspections] = await connection.query('SELECT * FROM qc_inspections WHERE id = 90');
    console.log(JSON.stringify(inspections, null, 2));

    if (inspections.length > 0) {
      const lotId = inspections[0].qc_lot_id;
      const productId = inspections[0].qc_lot_item_id; // Check this match

      console.log('\n--- Lot details (ID: ' + lotId + ') ---');
      const [lots] = await connection.query('SELECT * FROM qc_lots WHERE id = ?', [lotId]);
      console.log(JSON.stringify(lots, null, 2));

      console.log('\n--- Transit Transactions for Lot ' + lotId + ' ---');
      const [transits] = await connection.query(`
        SELECT * FROM inventory_transactions 
        WHERE qc_lot_id = ? AND movement = 'IN TRANSIT'
      `, [lotId]);
      console.log(JSON.stringify(transits, null, 2));
      
      console.log('\n--- Movement Transactions for Inspection 90 ---');
      const [movements] = await connection.query(`
        SELECT * FROM inventory_transactions 
        WHERE qc_inspection_id = 90
      `, []);
      console.log(JSON.stringify(movements, null, 2));
    }

    await connection.end();
  } catch (err) {
    console.error(err);
  }
}

debugInspection();
