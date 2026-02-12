import db from "./db.js";

async function checkPermissions() {
    try {
        const [users] = await db.promise().query('SELECT id, name, email FROM user LIMIT 5');
        console.log('Users:', users);

        for (const user of users) {
            const [roles] = await db.promise().query(`
        SELECT r.name 
        FROM user_role ur 
        JOIN role r ON r.id = ur.role_id 
        WHERE ur.user_id = ?
      `, [user.id]);
            console.log(`User ${user.name} roles:`, roles.map(r => r.name));

            const [perms] = await db.promise().query(`
        SELECT m.key_name, a.key_name as action, rp.allowed
        FROM role_permission rp
        JOIN user_role ur ON ur.role_id = rp.role_id
        JOIN menu_module m ON m.id = rp.module_id
        JOIN permission_action a ON a.id = rp.action_id
        WHERE ur.user_id = ?
        LIMIT 10
      `, [user.id]);
            console.log(`User ${user.name} permissions sample:`, perms);
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit();
    }
}

checkPermissions();
