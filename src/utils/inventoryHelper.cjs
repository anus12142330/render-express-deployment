// server/src/utils/inventoryHelper.cjs (CommonJS version)
const { pool } = require('../db/tx.cjs');

/**
 * Check if inventory movement is enabled in system settings
 * @returns {Promise<boolean>} true if inventory movement is enabled, false otherwise
 */
async function isInventoryMovementEnabled() {
  try {
    const [rows] = await pool.query(`
      SELECT setting_value FROM system_settings WHERE setting_key = 'inventory_movement_enabled'
    `);
    const setting = rows[0];
    
    if (!setting) {
      // Default to enabled if setting doesn't exist
      return true;
    }
    
    const value = setting.setting_value;
    return value === '1' || value === 'true' || value === true;
  } catch (e) {
    console.error('Error checking inventory movement setting:', e);
    // Default to enabled on error to avoid breaking existing functionality
    return true;
  }
}

module.exports = { isInventoryMovementEnabled };

