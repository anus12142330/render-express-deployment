// server/middleware/authz.js (ESM)
import db from '../db.js';

export function requireAuth(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user; // make available downstream
  next();
}

export function requirePerm(moduleKeyOrKeys, actionKey = 'view') {
  const moduleKeys = Array.isArray(moduleKeyOrKeys) ? moduleKeyOrKeys : [moduleKeyOrKeys];
  return async (req, res, next) => {
    const userId = req.user?.id || req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not logged in' });

    // Super Admin bypass
    const [adm] = await db.promise().query(
      `SELECT 1
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
        WHERE ur.user_id=? AND r.name='Super Admin'
        LIMIT 1`, [userId]
    );
    if (adm[0]) return next();

    // Check permission for any of the given modules
    const [ok] = await db.promise().query(
      `SELECT 1
         FROM user_role ur
         JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.allowed=1
         JOIN menu_module m ON m.id = rp.module_id
         JOIN permission_action a ON a.id = rp.action_id
        WHERE ur.user_id=? AND m.key_name IN (?) AND a.key_name=? LIMIT 1`,
      [userId, moduleKeys, actionKey]
    );

    if (!ok.length) {
      console.log(`[AUTHZ] Forbidden: User ${userId} lacks ${actionKey} on [${moduleKeys.join(', ')}]`);
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

/** Require any of the given (moduleKey, actionKey) permissions. */
export function requireAnyPerm(permList) {
  return async (req, res, next) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not logged in' });

    const [adm] = await db.promise().query(
      `SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
       WHERE ur.user_id=? AND r.name='Super Admin' LIMIT 1`,
      [userId]
    );
    if (adm[0]) return next();

    for (const { moduleKey, actionKey = 'view' } of permList) {
      const [ok] = await db.promise().query(
        `SELECT 1 FROM user_role ur
         JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.allowed=1
         JOIN menu_module m ON m.id = rp.module_id
         JOIN permission_action a ON a.id = rp.action_id
         WHERE ur.user_id=? AND m.key_name=? AND a.key_name=? LIMIT 1`,
        [userId, moduleKey, actionKey]
      );
      if (ok.length) return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  };
}

/** Check if user has a permission (for use in controllers). Returns true if Super Admin or has the permission. */
export async function hasPermission(userId, moduleKey, actionKey) {
  if (!userId || !moduleKey || !actionKey) return false;
  const [adm] = await db.promise().query(
    `SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
     WHERE ur.user_id=? AND r.name='Super Admin' LIMIT 1`,
    [userId]
  );
  if (adm[0]) return true;
  const [ok] = await db.promise().query(
    `SELECT 1 FROM user_role ur
     JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.allowed=1
     JOIN menu_module m ON m.id = rp.module_id
     JOIN permission_action a ON a.id = rp.action_id
     WHERE ur.user_id=? AND m.key_name=? AND a.key_name=? LIMIT 1`,
    [userId, moduleKey, actionKey]
  );
  return ok.length > 0;
}
