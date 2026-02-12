import db from "./db.js";

async function checkRoles() {
    try {
        const [roles] = await db.promise().query('SELECT id, name FROM role');
        console.log('Roles:', roles);

        for (const role of roles) {
            const [perms] = await db.promise().query(`
        SELECT m.key_name, a.key_name as action, rp.allowed
        FROM role_permission rp
        JOIN menu_module m ON m.id = rp.module_id
        JOIN permission_action a ON a.id = rp.action_id
        WHERE rp.role_id = ?
        AND rp.allowed = 1
        LIMIT 20
      `, [role.id]);
            console.log(`Role ${role.name} allowed permissions sample:`, perms);
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit();
    }
}

checkRoles();
