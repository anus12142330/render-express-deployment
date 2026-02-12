import db from './db.js';

const GROUPS = [
  { name: 'Contacts', sort_order: 10 },
  { name: 'Items', sort_order: 20 },
  { name: 'Sales', sort_order: 30 },
  { name: 'Purchase', sort_order: 40 },
  { name: 'Operations', sort_order: 45 },
  { name: 'Accountant', sort_order: 50 },
  { name: 'Settings', sort_order: 999 },
];

// --- Define your application's structure here ---
// This becomes the single source of truth for your menus and permissions.
const MODULES = [
  // --- Contacts ---
  { key_name: 'Customers', group_name: 'Contacts', display_name: 'Customers', sort_order: 10 },
  { key_name: 'Vendors', group_name: 'Contacts', display_name: 'Vendors', sort_order: 20 },

  // --- Items ---
  { key_name: 'Products', group_name: 'Items', display_name: 'Items', sort_order: 10 },

  // --- Sales ---
  { key_name: 'ProformaInvoices', group_name: 'Sales', display_name: 'Proforma Invoices', sort_order: 10 },
  { key_name: 'Invoices', group_name: 'Sales', display_name: 'Invoices', sort_order: 20 },

  // --- Purchase ---
  { key_name: 'PurchaseOrders', group_name: 'Purchase', display_name: 'Purchase Orders', sort_order: 10 },
  { key_name: 'Bills', group_name: 'Purchase', display_name: 'Bills', sort_order: 20 },

  // --- Operations ---
  { key_name: 'CargoArrivalSummary', group_name: 'Operations', display_name: 'Cargo Arrival Summary', sort_order: 10 },
  { key_name: 'UpcomingShipment', group_name: 'Operations', display_name: 'Upcoming Shipment', sort_order: 20 },

  // --- Quality Check ---
  { key_name: 'QualityCheck', group_name: 'Operations', display_name: 'Quality Check', sort_order: 30 },

  // --- Accountant ---
  { key_name: 'InternalFundTransfer', group_name: 'Accountant', display_name: 'Internal Fund Transfer', sort_order: 10 },
  { key_name: 'OpeningBalance', group_name: 'Accountant', display_name: 'Opening Balances', sort_order: 20 },

  // --- Settings ---
  { key_name: 'OrganisationUsersRoles', group_name: 'Settings', display_name: 'Profile', sort_order: 10 },
  { key_name: 'Warehouses', group_name: 'Settings', display_name: 'Warehouse', sort_order: 20 },
  { key_name: 'EmailSettings', group_name: 'Settings', display_name: 'Email Settings', sort_order: 30 },
  { key_name: 'TemplateSettings', group_name: 'Settings', display_name: 'Document Template', sort_order: 40 },
  { key_name: 'Master', group_name: 'Settings', display_name: 'Master', sort_order: 50 },
  { key_name: 'Role', group_name: 'Settings', display_name: 'Role Management', sort_order: 60 },
  { key_name: 'CompanySettings', group_name: 'Settings', display_name: 'Company Settings', sort_order: 70 },
];

const ACTIONS = [
  { key_name: 'view', display_name: 'View', is_core: 1, sort_order: 10 },
  { key_name: 'create', display_name: 'Create', is_core: 1, sort_order: 20 },
  { key_name: 'edit', display_name: 'Edit', is_core: 1, sort_order: 30 },
  { key_name: 'delete', display_name: 'Delete', is_core: 1, sort_order: 40 },
  { key_name: 'approve', display_name: 'Approve', is_core: 1, sort_order: 50 },
  // Example of a non-core, specific action
  { key_name: 'more_bank_edit', display_name: 'Edit Vendor Bank Details', is_core: 0, sort_order: 100 }
];
// --- End of definitions ---

async function seed() {
  const conn = await db.promise();
  console.log('Database connected. Starting seeder...');

  try {
    // Upsert groups
    console.log('Syncing `menu_group` table...');
    for (const group of GROUPS) {
      await conn.query(
        `INSERT INTO menu_group (group_name, sort_order)
         VALUES (?, ?) ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)`,
        [group.name, group.sort_order]
      );
    }
    console.log(`-> ${GROUPS.length} groups synced.`);

    // Upsert actions (INSERT on duplicate KEY UPDATE)
    console.log('Syncing `permission_action` table...');
    for (const action of ACTIONS) {
      await conn.query(
        `INSERT INTO permission_action (key_name, display_name, is_core, sort_order)
         VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE
           display_name = VALUES(display_name), is_core = VALUES(is_core), sort_order = VALUES(sort_order)`,
        [action.key_name, action.display_name, action.is_core, action.sort_order]
      );
    }
    console.log(`-> ${ACTIONS.length} actions synced.`);

    // Upsert modules
    console.log('Syncing `menu_module` table...');
    for (const mod of MODULES) {
      await conn.query(
        `INSERT INTO menu_module (key_name, group_name, display_name, sort_order)
         VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE
           group_name = VALUES(group_name), display_name = VALUES(display_name), sort_order = VALUES(sort_order)`,
        [mod.key_name, mod.group_name, mod.display_name, mod.sort_order]
      );
    }
    console.log(`-> ${MODULES.length} modules synced.`);

    console.log('\n✅ Seeding complete!');
  } catch (error) {
    console.error('\n❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

seed();