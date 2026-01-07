// server/src/utils/inventoryHelper.js
import db from '../../db.js';

/**
 * Check if inventory movement is enabled in system settings
 * @returns {Promise<boolean>} true if inventory movement is enabled, false otherwise
 */
export const isInventoryMovementEnabled = async () => {
  try {
    const [[setting]] = await db.promise().query(`
      SELECT setting_value FROM system_settings WHERE setting_key = 'inventory_movement_enabled'
    `);
    
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
};

