import db from '../db.js';

async function migrate() {
    try {
        const [columns] = await db.promise().query("SHOW COLUMNS FROM `user` LIKE 'biometric_login_enabled'");
        if (columns.length === 0) {
            console.log('Adding biometric_login_enabled column...');
            await db.promise().query("ALTER TABLE `user` ADD COLUMN `biometric_login_enabled` TINYINT(1) DEFAULT 0");
            console.log('Column added successfully.');
        } else {
            console.log('Column already exists.');
        }
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
