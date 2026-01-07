// server/routes/systemSettings.js
import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requirePerm } from '../middleware/authz.js';

const router = Router();

// Helper function for error responses
const errPayload = (message, code, details) => ({
  error: { message, code, details }
});

// GET /api/system-settings - Get all system settings
router.get('/', requireAuth, async (req, res) => {
  try {
    const [settings] = await db.promise().query(`
      SELECT setting_key, setting_value, setting_type, description, updated_at
      FROM system_settings
      ORDER BY setting_key
    `);

    // Convert settings to object format
    const settingsObj = {};
    settings.forEach(setting => {
      let value = setting.setting_value;
      if (setting.setting_type === 'boolean') {
        value = value === '1' || value === 'true' || value === true;
      } else if (setting.setting_type === 'number') {
        value = parseFloat(value) || 0;
      } else if (setting.setting_type === 'json') {
        try {
          value = JSON.parse(value);
        } catch (e) {
          value = value;
        }
      }
      settingsObj[setting.setting_key] = {
        value,
        type: setting.setting_type,
        description: setting.description,
        updated_at: setting.updated_at
      };
    });

    res.json(settingsObj);
  } catch (e) {
    console.error('Error fetching system settings:', e);
    res.status(500).json(errPayload('Failed to fetch system settings', 'DB_ERROR', e.message));
  }
});

// GET /api/system-settings/:key - Get a specific setting
router.get('/:key', requireAuth, async (req, res) => {
  try {
    const { key } = req.params;
    const [[setting]] = await db.promise().query(`
      SELECT setting_key, setting_value, setting_type, description, updated_at
      FROM system_settings
      WHERE setting_key = ?
    `, [key]);

    if (!setting) {
      return res.status(404).json(errPayload('Setting not found', 'NOT_FOUND'));
    }

    let value = setting.setting_value;
    if (setting.setting_type === 'boolean') {
      value = value === '1' || value === 'true' || value === true;
    } else if (setting.setting_type === 'number') {
      value = parseFloat(value) || 0;
    } else if (setting.setting_type === 'json') {
      try {
        value = JSON.parse(value);
      } catch (e) {
        value = value;
      }
    }

    res.json({
      key: setting.setting_key,
      value,
      type: setting.setting_type,
      description: setting.description,
      updated_at: setting.updated_at
    });
  } catch (e) {
    console.error('Error fetching system setting:', e);
    res.status(500).json(errPayload('Failed to fetch system setting', 'DB_ERROR', e.message));
  }
});

// PUT /api/system-settings/:key - Update a specific setting
router.put('/:key', requireAuth, requirePerm('Settings', 'edit'), async (req, res) => {
  try {
    const { key } = req.params;
    const { value, description } = req.body;
    const userId = req.session?.user?.id;

    if (value === undefined || value === null) {
      return res.status(400).json(errPayload('Setting value is required', 'VALIDATION_ERROR'));
    }

    // Get existing setting to determine type
    const [[existing]] = await db.promise().query(`
      SELECT setting_type FROM system_settings WHERE setting_key = ?
    `, [key]);

    if (!existing) {
      return res.status(404).json(errPayload('Setting not found', 'NOT_FOUND'));
    }

    // Convert value to string based on type
    let settingValue = value;
    if (existing.setting_type === 'boolean') {
      settingValue = (value === true || value === 'true' || value === 1 || value === '1') ? '1' : '0';
    } else if (existing.setting_type === 'number') {
      settingValue = String(parseFloat(value) || 0);
    } else if (existing.setting_type === 'json') {
      settingValue = typeof value === 'string' ? value : JSON.stringify(value);
    } else {
      settingValue = String(value);
    }

    await db.promise().query(`
      UPDATE system_settings
      SET setting_value = ?,
          description = COALESCE(?, description),
          updated_by = ?,
          updated_at = NOW()
      WHERE setting_key = ?
    `, [settingValue, description || null, userId, key]);

    res.json({ message: 'Setting updated successfully', key, value: settingValue });
  } catch (e) {
    console.error('Error updating system setting:', e);
    res.status(500).json(errPayload('Failed to update system setting', 'DB_ERROR', e.message));
  }
});

export default router;

