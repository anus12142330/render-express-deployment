import db from './db.js';
import fs from 'fs';

db.promise().query('SELECT key_name FROM menu_module')
  .then(res => fs.writeFileSync('tmp_perms2.json', JSON.stringify(res[0], null, 2), 'utf-8'))
  .catch(console.error)
  .finally(() => process.exit(0));
