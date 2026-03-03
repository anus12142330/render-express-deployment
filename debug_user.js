import db from './db.js';
const [rows] = await db.promise().query('DESCRIBE `user`');
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
