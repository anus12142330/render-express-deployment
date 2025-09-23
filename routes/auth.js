import { Router } from 'express';
import db from '../db.js';

const router = Router();
const q = async (sql, p = []) => (await db.promise().query(sql, p))[0];

/**
 * GET /api/auth/me
 * Fetches the current logged-in user's profile and permissions.
 */
router.get('/me', async (req, res) => {
  try {
    // --- SIMULATION: In a real app, get userId from a session or JWT ---
    const userId = 1; // Assuming user with ID 1 is logged in.
    const [user] = await q(`
      SELECT u.id, u.name, u.email, u.role_id, r.name as role_name
      FROM user u
      LEFT JOIN role r ON u.role_id = r.id
      WHERE u.id = ?`, [userId]);

    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const roleId = user.role_id;
    if (!roleId) {
      // If user has no role, return the user with empty permissions
      return res.json({ user, permissions: {} });
    }
    // --- END SIMULATION ---

    // Fetch all modules, actions, and the role's specific permissions
    const mods = await q(`SELECT id, key_name FROM menu_module WHERE is_active=1`);
    const acts = await q(`SELECT id, key_name FROM permission_action`);
    const perms = await q(`SELECT module_id, action_id, allowed FROM role_permission WHERE role_id=?`, [roleId]);

    // Create lookup maps for performance
    const mById = Object.fromEntries(mods.map(m => [m.id, m.key_name]));
    const aById = Object.fromEntries(acts.map(a => [a.id, a.key_name]));

    // Build the final permission object: { [moduleKey]: { [actionKey]: boolean } }
    const permissions = {};
    for (const p of perms) {
      const moduleKey = mById[p.module_id];
      const actionKey = aById[p.action_id];
      if (moduleKey && actionKey && p.allowed === 1) {
        (permissions[moduleKey] ||= {})[actionKey] = true;
      }
    }

    res.json({ user, permissions });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch user permissions', details: e.message });
  }
});

export default router;