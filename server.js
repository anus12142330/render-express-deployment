import cors from 'cors';
import crypto from 'crypto';
import express from 'express';
import session from 'express-session';
import fs from 'fs';
import { createRequire } from 'module';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import './cronJobs/expireCheck.js';
import db from "./db.js";
import { requireAuth } from './middleware/authz.js';
import { optionalBearerSession, signMobileToken } from './middleware/mobileAuth.js';
import bankRoutes from './routes/bank.js';
import bankAccountRoutes from './routes/bankAccounts.js';
import brandRoutes from './routes/brand.js';
import containerLoadRoutes from './routes/containerLoad.js';
import containerTypeRoutes from './routes/containerType.js';
import customerRoutes from './routes/customer.js';
import deliveryOrderRoutes from "./routes/deliveryOrder.js"; // Import the new sales order router
import documentRoutes from './routes/document.js';
import documentsRoutes from './routes/documents.js';
import documentTemplateRoutes from './routes/documentTemplate.js';
import documentTypeRoutes from './routes/documentType.js';
import driverRoutes from './routes/driver.js';
import fleetRoutes from './routes/fleet.js';
import fundTransferRoutes from './routes/fundTransfer.js';
import harvestCalendarRoutes from "./routes/harvestCalendar.js"; // Import the new router
import incoRoutes from './routes/inco.js';
import inwardPaymentsRoutes from './routes/inwardPayments.js';
import manufactureRoutes from './routes/manufacture.js';
import masterRoutes from "./routes/master.js";
import modeShipmentRoutes from './routes/modeShipment.js';
import openingBalanceRoutes from './routes/openingBalance.js';
import outwardPaymentsRoutes from './routes/outwardPayments.js';
import partialShipmentRoutes from './routes/partialShipment.js';
import paymentTermsRoutes from './routes/paymentTerms.js';
import poTimelineRoutes from './routes/poTimeline.js';
import portRoutes from './routes/port.js';
import productRoutes from './routes/products.js';
import proformaRoutes from './routes/proforma.js';
import purchasebillRoutes from './routes/purchasebillk.js';
import purchaseorderRoutes from './routes/purchaseorder.js';
import qualityCheckRoutes from './routes/qualityCheck.js';
import rbacRoutes from './routes/rbac.js';
import roleRoutes from './routes/roles.js';
import routePlannerRoutes from './routes/routePlanner.js';
import salesQuoteRoutes from './routes/salesQuote.js';
import salesOrderRoutes from './src/modules/sales-order/salesOrder.routes.js';
import shipmentRoutes from './routes/shipment.js';
import shipmentDocumentsRoutes from './routes/shipmentDocuments.js';
import shipmentStageRoutes from './routes/shipmentStage.js';
import statusRoutes from './routes/status.js';
import systemSettingsRoutes from './routes/systemSettings.js';
import taxesRoutes from './routes/taxes.js';
import termsconditionRoutes from './routes/termscondition.js';
import uomRoutes from './routes/uom.js';
import uploadRoutes from "./routes/upload.js";
import vendorRoutes from './routes/vendor.js';
import warehousesRoutes from "./routes/warehouses.js";
import mobileAuthRoutes from "./routes/mobileAuth.js";
import mobileQcRoutes from "./routes/mobileQc.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Helper function to run queries with promises and return rows
const q = async (sql, p = []) => (await db.promise().query(sql, p))[0];

// Import CommonJS modules for AP/AR/Inventory
const apRoutes = require('./src/modules/ap/ap.routes.cjs');
const arRoutes = require('./src/modules/ar/ar.routes.cjs');
const inventoryRoutes = require('./src/modules/inventory/inventory.routes.cjs');
const operationsRoutes = require('./routes/operations.cjs');

const app = express();
const mobileOrigins = [
  "http://localhost",
  "http://127.0.0.1",
  "capacitor://localhost",
  "http://localhost:19006",
  "http://localhost:19000",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://10.0.2.2:7555",
  "http://10.0.2.2:19006",
  "http://10.0.2.2:19000"
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (mobileOrigins.includes(origin) || origin.includes('localhost') || origin.includes('capacitor://')) return cb(null, true);
    if (origin.includes("onrender.com")) return cb(null, true);
    return cb(null, true);
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
//app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// session
app.set('trust proxy', 1);
app.use(session({
  secret: 'your-secret-key',
  resave: true,
  saveUninitialized: true,
  cookie: {
    sameSite: 'lax',
    secure: false, // Ensure this is false for localhost
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

// Request Logger for debugging session issues
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url} - SID: ${req.sessionID}`);
  if (req.session?.user) {
    console.log(`  User: ${req.session.user.email}`);
  } else {
    console.log('  No Auth Session');
  }
  next();
});

// Mobile: if Authorization: Bearer <token> is present, set req.session.user so all API routes work
// (session cookies are not sent from capacitor://localhost to Render)
app.use(optionalBearerSession);

const vendorStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/vendor'); // ⬅️ Folder where files are saved
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname); // Get extension (e.g., .jpg)
    const name = crypto.randomBytes(16).toString('hex'); // Unique name
    cb(null, name + ext); // Save as uniqueName.jpg
  }
});

const productStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/product'); // ⬅️ Folder where files are saved
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname); // Get extension (e.g., .jpg)
    const name = crypto.randomBytes(16).toString('hex'); // Unique name
    cb(null, name + ext); // Save as uniqueName.jpg
  }
});


const companyStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/company'); // ⬅️ Folder where files are saved
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname); // Get extension (e.g., .jpg)
    const name = crypto.randomBytes(16).toString('hex'); // Unique name
    cb(null, name + ext); // Save as uniqueName.jpg
  }
});
const userStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/users");
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = crypto.randomBytes(16).toString('hex');
    cb(null, name + ext);
  },
});



const upload = multer({ storage: productStorage });
const uploadv = multer({ storage: vendorStorage });
const uploadc = multer({ storage: companyStorage });
const uploadUserPhoto = multer({ storage: userStorage });

const uploadCompany = uploadc.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'company_stamp', maxCount: 1 }
]);


/* ---------- Helpers ---------- */
const likeWrap = (s = '') => `%${s || ''}%`;

//  const db = mysql.createConnection({
//  host: process.env.DB_HOST || "localhost",
//   user: process.env.DB_USER || "root",
//   password: process.env.DB_PASSWORD || "",
//   database: process.env.DB_NAME || "portal_db",
// }); 

//  db.connect(err => {
//   if (err) {
//     console.error('❌ MySQL connection failed:', err);
//     process.exit(1);
//   }
//   console.log('✅ Connected to MySQL database');
// }); 




// ✅ HEALTH CHECK (Root endpoint for Render)
app.get('/', (req, res) => {
  res.json({ success: true, message: 'API running', timestamp: new Date().toISOString() });
});

app.use("/api/purchaseorder", purchaseorderRoutes);
app.use("/api/po-timeline", poTimelineRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/vendors", vendorRoutes);
app.use("/api/ports", portRoutes);
app.use("/api/mode-shipment", modeShipmentRoutes);
app.use("/api/incoterms", incoRoutes);
app.use("/api/uoms", uomRoutes);
app.use("/api/termscondition", termsconditionRoutes);
app.use("/api/taxes", taxesRoutes);
app.use("/api/purchase-bills", purchasebillRoutes);
app.use("/api/status", statusRoutes);
app.use("/api/shipment", shipmentRoutes);
app.use("/api/document-types", documentTypeRoutes);
app.use("/api/shipment-documents", shipmentDocumentsRoutes);
app.use("/api/shipment-stages", shipmentStageRoutes);
app.use("/api/proforma-invoices", proformaRoutes);
app.use("/api/sales-quotes", salesQuoteRoutes);
app.use("/api/sales-orders", salesOrderRoutes);
app.use("/api/bank", bankRoutes);
app.use("/api/bank-accounts", bankAccountRoutes);
app.use("/api/fund-transfer", fundTransferRoutes);
app.use("/api/opening-balances", openingBalanceRoutes);
app.use("/api", outwardPaymentsRoutes);
app.use("/api", inwardPaymentsRoutes);
app.use("/api/partial-shipment", partialShipmentRoutes);
app.use("/api/container-type", containerTypeRoutes);
app.use("/api/container-load", containerLoadRoutes);
app.use("/api/document", documentRoutes);
app.use("/api/documents", documentsRoutes);
app.use("/api/fleet", fleetRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/brand", brandRoutes);
app.use("/api/manufacture", manufactureRoutes);
app.use('/api/route-planner', routePlannerRoutes);
app.use("/api/delivery-orders", deliveryOrderRoutes); // Mount the new sales order router
app.use("/api/master", masterRoutes);
app.use("/api/harvest-calendar", harvestCalendarRoutes); // Mount the new router
app.use("/api/warehouses", warehousesRoutes);
app.use("/api/mobile", mobileAuthRoutes);
app.use("/api/mobile", mobileQcRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/rbac', rbacRoutes);
app.use('/api/paymentTerms', paymentTermsRoutes);
app.use('/api/document-template', documentTemplateRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/quality-check', qualityCheckRoutes);
app.use('/api/system-settings', systemSettingsRoutes);

// AP/AR/Inventory routes (CommonJS modules)
app.use('/api/ap', apRoutes);
app.use('/api/ar', arRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api', operationsRoutes);

// GL (General Ledger) routes
const glRoutes = require('./src/modules/gl/gl.routes.cjs');
app.use('/api/gl', glRoutes);

// Reports routes
const reportsRoutes = require('./src/modules/reports/reports.routes.cjs');
app.use('/api/reports', reportsRoutes);

//Role permission
app.get('/api/me', requireAuth, async (req, res) => {
  const sessionUser = req.session?.user || null;
  if (!sessionUser) return res.status(401).json({ user: null });

  // Enrich user with full details and roles
  const userRows = await q(`
    SELECT
        u.id,
        u.name AS user_name,
        u.designation,
        u.email,
        u.photo_path,
        d.name AS department_name,
        GROUP_CONCAT(r.name) as roles
    FROM \`user\` u
    LEFT JOIN department d ON d.id = u.department_id
    LEFT JOIN user_role ur ON ur.user_id = u.id
    LEFT JOIN role r ON r.id = ur.role_id
    WHERE u.id = ?
    GROUP BY u.id
  `, [sessionUser.id]);

  const userWithDetails = userRows[0] || null;
  if (userWithDetails && userWithDetails.roles) {
    userWithDetails.roles = userWithDetails.roles.split(',');
  }

  res.json({ user: userWithDetails });
});

app.get('/api/debug-session', (req, res) => {
  res.json({
    session: req.session,
    user: req.user,
    cookies: req.cookies,
    headers: req.headers
  });
});




app.get('/api/me/permissions', requireAuth, async (req, res) => {
  const userId = req.user.id;// or JWT subject
  if (!userId) return res.status(401).json({});

  console.log(`[PERMISSIONS] Fetching for user ID: ${userId}`);

  const rows = await q(`
    SELECT m.key_name AS module_key, a.key_name AS action_key, MAX(rp.allowed) AS allowed
    FROM user_role ur
    JOIN role_permission rp ON rp.role_id = ur.role_id
    JOIN menu_module m ON m.id = rp.module_id
    JOIN permission_action a ON a.id = rp.action_id
    WHERE ur.user_id = ?
    GROUP BY m.key_name, a.key_name
  `, [userId]);

  console.log(`[PERMISSIONS] Found ${rows.length} permission entries for user ID: ${userId}`);

  const out = {};
  rows.forEach(r => { (out[r.module_key] ||= {})[r.action_key] = r.allowed === 1; });
  res.json(out);
});


// ✅ GET ALL USERS
app.get('/api/users', (req, res) => {
  const query = `
        SELECT
            u.id AS user_id,
            u.name AS user_name,
            u.designation,
            u.email,
            u.password,
            u.department_id,
            d.name AS department_name,
            u.photo_path,
            GROUP_CONCAT(DISTINCT ur.role_id) as role_ids,
            GROUP_CONCAT(DISTINCT r.name SEPARATOR ", ") as role_name
        FROM \`user\` u
                 LEFT JOIN department d ON d.id = u.department_id
                 LEFT JOIN user_role ur ON ur.user_id = u.id
                 LEFT JOIN role r ON r.id = ur.role_id
        WHERE u.is_inactive = 0
        GROUP BY
            u.id, u.name, u.designation, u.email, u.password, u.department_id, d.name, u.photo_path
    `;
  db.query(query, (err, results) => {
    if (err) {
      console.error('SQL ERROR (GET /api/users):', err);
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json(results);
  });
});

// ✅ GET ALL DEPARTMENTS
app.get('/api/departments', (req, res) => {
  db.query('SELECT id, name FROM department', (err, results) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json(results);
  });
});

// ✅ GET ALL PROVISIONS
app.get('/api/provisions', (req, res) => {
  db.query('SELECT id, name FROM provision', (err, results) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json(results);
  });
});

// ✅ LOGIN

// list users (debug)
app.get('/api/login-debug', (req, res) => {
  db.query('SELECT id,name,email,is_inactive FROM `user` ORDER BY id LIMIT 200',
    (err, rows) => err ? res.status(500).json({ success: false, error: err.message })
      : res.json({ success: true, users: rows })
  );
});

// demo credentials (debug only)
app.get('/api/login-debug-credential', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, message: 'Not available in production' });
  }
  try {
    const [columns] = await db.promise().query("SHOW COLUMNS FROM `user` LIKE 'user_name'");
    const hasUserName = columns.length > 0;
    const baseSelect = hasUserName
      ? "SELECT id, user_name, name, password FROM `user` WHERE is_inactive = 0"
      : "SELECT id, name, password FROM `user` WHERE is_inactive = 0";
    const [rows] = await db
      .promise()
      .query(
        `${baseSelect} AND password IS NOT NULL AND password <> '' ORDER BY (id = 1) DESC, id ASC LIMIT 1`
      );
    if (!rows.length) {
      return res.json({ success: false, message: "No active users with passwords found" });
    }
    const row = rows[0];
    const username = row.user_name || row.name || "";
    return res.json({ success: true, user: { id: row.id, username, password: row.password } });
  } catch (err) {
    console.error('❌ Debug credential error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Database error' });
  }
});

app.post('/api/login', async (req, res) => {

  const identifier = String(req.body?.email ?? '').trim();
  const password = String(req.body?.password ?? '').trim();
  console.log('[LOGIN]', { identifier, passwordLen: password.length });

  try {
    const [columns] = await db.promise().query("SHOW COLUMNS FROM `user` LIKE 'user_name'");
    const hasUserName = columns.length > 0;
    const loginSql = hasUserName
      ? 'SELECT id, email FROM user WHERE (email = ? OR name = ? OR user_name = ?) AND password = ? AND is_inactive = 0'
      : 'SELECT id, email FROM user WHERE (email = ? OR name = ?) AND password = ? AND is_inactive = 0';
    const loginParams = hasUserName
      ? [identifier, identifier, identifier, password]
      : [identifier, identifier, password];
    const [loginRows] = await db.promise().query(loginSql, loginParams);

    if (loginRows.length === 0) {
      return res.json({ success: false, message: 'Invalid credentials' });
    }

    const loggedInUser = loginRows[0];
    req.session.user = { id: loggedInUser.id, email: loggedInUser.email };

    // Now, enrich the user with full details to return to the client
    const [detailsRows] = await db.promise().query(`
      SELECT
          u.id, u.name AS user_name, u.designation, u.email, u.photo_path,
          d.name AS department_name, GROUP_CONCAT(r.name) as roles
      FROM \`user\` u
      LEFT JOIN department d ON d.id = u.department_id
      LEFT JOIN user_role ur ON ur.user_id = u.id
      LEFT JOIN role r ON r.id = ur.role_id
      WHERE u.id = ?
      GROUP BY u.id
    `, [loggedInUser.id]);

    const userWithDetails = detailsRows[0] || null;
    if (userWithDetails && userWithDetails.roles) {
      userWithDetails.roles = userWithDetails.roles.split(',');
    }

    // Return a JWT so mobile app (Capacitor) can send Bearer token; session cookies are not sent cross-origin
    const token = signMobileToken({ id: loggedInUser.id, email: loggedInUser.email });
    res.json({ success: true, user: userWithDetails, token });
  } catch (err) {
    console.error('❌ Login error:', err);
    console.error('❌ Login error stack:', err.stack);
    res.status(500).json({ success: false, error: err.message || 'Database error', details: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  }
});

// ✅ LOGOUT
app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Could not log out, please try again.' });
    }
    // It's good practice to clear the cookie on the client-side as well
    res.clearCookie('connect.sid'); // Use the name of your session cookie if different
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// ✅ CHANGE PASSWORD
app.post('/api/user/change-password', (req, res) => {
  const { userId, oldPassword, newPassword } = req.body;

  db.query('SELECT * FROM user WHERE id = ? AND password = ?', [userId, oldPassword], (err, results) => {
    if (err) {
      console.error('❌ DB error:', err);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    if (results.length === 0) {
      return res.status(400).json({ success: false, message: 'Old password is incorrect' });
    }

    db.query('UPDATE user SET password = ? WHERE id = ?', [newPassword, userId], (err, updateResult) => {
      if (err) {
        console.error('❌ Error updating password:', err);
        return res.status(500).json({ success: false, error: 'Database update error' });
      }
      res.json({ success: true, message: 'Password updated successfully' });
    });
  });
});

// ✅ CREATE USER
app.post("/api/user", uploadUserPhoto.single("photo"), (req, res) => {
  const { name, designation, department_id, role_ids, email, password } =
    req.body;
  const photoPath = req.file
    ? `uploads/users/${req.file.filename}`
    : null;

  db.getConnection(async (err, conn) => {
    if (err) return res.status(500).json({ success: false, error: 'DB Connection failed' });
    try {
      await conn.promise().beginTransaction();

      const userSql = `
              INSERT INTO \`user\` (name, designation, department_id, email, password, photo_path)
              VALUES (?, ?, ?, ?, ?, ?)
            `;
      const [userResult] = await conn.promise().query(userSql, [name, designation, department_id, email, password, photoPath]);
      const userId = userResult.insertId;

      if (role_ids && role_ids.length > 0) {
        const roles = Array.isArray(role_ids) ? role_ids : role_ids.split(',');
        const userRoleValues = roles.map(roleId => [userId, roleId]);
        await conn.promise().query('INSERT INTO user_role (user_id, role_id) VALUES ?', [userRoleValues]);
      }

      await conn.promise().commit();
      res.json({ success: true, id: userId });

    } catch (dbErr) {
      await conn.promise().rollback();
      console.error("SQL ERROR (POST /api/user):", dbErr);
      res.status(500).json({ success: false, error: dbErr.message });
    } finally {
      conn.release();
    }
  });
});

// === UPDATE USER ===
app.put("/api/user/:id", uploadUserPhoto.single("photo"), async (req, res) => {
  const { id } = req.params;
  const { name, designation, department_id, role_ids, email, password } =
    req.body;

  const conn = await db.promise().getConnection();

  try {
    await conn.beginTransaction();

    // Fetch current user data to get existing password and signature
    const [rows] = await conn.execute("SELECT password, photo_path FROM `user` WHERE id = ?", [id]);
    if (!rows || rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const { password: currentPassword, photo_path: currentPhoto } = rows[0];

    const nextPassword = password && password.trim() !== "" ? password : currentPassword;

    // Signature logic
    let nextPhotoPath = currentPhoto;
    if (req.file) {
      nextPhotoPath = `uploads/users/${req.file.filename}`;
    }

    // Update user table
    const userUpdateSql = `UPDATE \`user\` SET name = ?, designation = ?, department_id = ?, email = ?, password = ?, photo_path = ? WHERE id = ?`;
    await conn.execute(userUpdateSql, [name, designation, department_id, email, nextPassword, nextPhotoPath, id]);

    // Update user_role table
    await conn.execute('DELETE FROM user_role WHERE user_id = ?', [id]);
    if (role_ids && role_ids.length > 0) {
      const roles = Array.isArray(role_ids) ? role_ids : role_ids.split(',');
      const userRoleValues = roles.map(roleId => [id, roleId]);
      if (userRoleValues.length > 0) {
        await conn.query('INSERT INTO user_role (user_id, role_id) VALUES ?', [userRoleValues]);
      }
    }

    await conn.commit();
    res.json({ success: true });

  } catch (dbErr) {
    if (conn) await conn.rollback(); // Check if conn exists before rollback
    console.error("SQL ERROR (PUT /api/user/:id):", dbErr);
    res.status(500).json({ success: false, error: dbErr.message });
  } finally {
    if (conn) conn.release(); // Check if conn exists before releasing
  }
});

// ✅ DEACTIVATE USER
app.put('/api/user/:id/deactivate', (req, res) => {
  const userId = req.params.id;
  db.query(
    'UPDATE user SET is_inactive = 1 WHERE id = ?',
    [userId],
    (err, result) => {
      if (err) {
        console.error('❌ Error deactivating user:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      res.json({ success: true, message: 'User marked as inactive' });
    }
  );
});

// ✅ GET PRODUCTS WITH PAGINATION + SEARCH + SORTING
/* ----------------------
   ✅ PRODUCT MASTER DATA
----------------------- */
/* ---------- Metadata for dropdowns ---------- */
// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------

// --- METADATA (units, brands, manufacturers, accounts, warehouses, vendors)
app.get('/api/products/metadata', (req, res) => {
  const queries = {
    units: 'SELECT id, name as unit_name FROM uom_master ORDER BY name',
    brands: 'SELECT id, brand_name FROM brands ORDER BY brand_name',
    manufacturers: 'SELECT id, name FROM manufacturers ORDER BY name',
    accounts: 'SELECT id, name, account_type_id FROM acc_chart_accounts ORDER BY name',
    warehouses: 'SELECT id, warehouse_name FROM warehouses ORDER BY warehouse_name',
    vendors: 'SELECT id, display_name FROM vendor ORDER BY display_name',
    taxes: "SELECT id, tax_name, rate, type FROM taxes WHERE is_active=1 ORDER BY tax_name",
    valuations: "SELECT id, code, method_name FROM valuation_methods WHERE is_active = 1 ORDER BY sort_order, method_name"
  };

  const results = {};
  let pending = Object.keys(queries).length;
  let responded = false;

  for (const key in queries) {
    db.query(queries[key], (err, rows) => {
      if (responded) return;
      if (err) {
        responded = true;
        return res.status(500).json({
          error: 'Error loading metadata',
          where: key,
          message: err.message
        });
      }
      results[key] = rows;
      if (--pending === 0 && !responded) res.json(results);
    });
  }
});


// Health check endpoint (used by Render)
app.get('/api/health', (req, res) => {
  db.query('SELECT 1', (err) => {
    if (err) {
      console.error('Health check DB error:', err.message);
      return res.status(500).json({ ok: false, message: err.message });
    }
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });
});


// ====== GET /api/products (list with search/pagination/sort) ======
// Helper function to run queries with promises
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}


// Products API
app.use('/api/products', productRoutes);



// Your POST route
app.post('/api/products', upload.array('images', 15), async (req, res) => {
  const b = req.body;
  const files = req.files || [];

  let openingRows = [];
  try {
    openingRows = JSON.parse(b.openingRows || '[]');
  } catch { }

  const primaryIndex = Number.isInteger(+b.primaryImageIndex) ? +b.primaryImageIndex : 0;

  // Combine dimensions into one string "L x W x H"
  const dimensions = [b.length || 0, b.width || 0, b.height || 0].join(' x ');

  const insertSql = `
        INSERT INTO products (
            item_type, product_name, sku, unit_id,
            returnable, excise,
            dimensions, dimensions_unit,
            weight, weight_unit,
            manufacturer_id, brand_id,
            upc, mpn, isbn, ean,
            enable_sales, selling_currency, selling_price, sales_account_id, sales_description, sales_tax,
            enable_purchase, cost_currency, cost_price, purchase_account_id, purchase_description,
            preferred_vendor_id, track_inventory, adv_tracking, inventory_account_id, valuation_method,
            reorder_point, hscode, description,
            created_at, updated_at
        ) VALUES (
                     ?, ?, ?, ?, ?, ?,
                     ?, ?,
                     ?, ?,
                     ?, ?,
                     ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?,
                     ?, ?, ?,
                     NOW(), NOW()
                 )
    `;

  const insertVals = [
    b.itemType || 'Goods',                 // product_type
    b.name || '',                          // product_name
    b.sku || null,                        // sku
    b.unitId || null,                     // unit_id

    b.returnable === '0' ? 0 : 1,         // returnable
    b.excise === '1' ? 1 : 0,             // excise

    dimensions,                           // dimensions (string)
    b.dimUnit || 'cm',                   // dimensions_unit

    b.weight || 0,                       // weight
    b.weightUnit || 'kg',                // weight_unit

    b.manufacturer || null,              // manufacturer_id
    b.brand || null,                     // brand_id

    b.upc || null,                      // upc
    b.mpn || null,                      // mpn
    b.isbn || null,                     // isbn
    b.ean || null,                      // ean

    b.enableSales === '0' ? 0 : 1,      // enable_sales
    b.sellingCurrency || 'AED',          // selling_currency
    b.sellingPrice || 0,                 // selling_price
    b.salesAccount || null,              // sales_account_id
    b.salesDescription || null,          // sales_description
    b.salesTax || null,                  // sales_tax

    b.enablePurchase === '0' ? 0 : 1,   // enable_purchase
    b.costCurrency || 'AED',              // cost_currency
    b.costPrice || 0,                    // cost_price
    b.purchaseAccount || null,           // purchase_account_id
    b.purchaseDescription || null,       // purchase_description

    b.preferredVendor || null,            // preferred_vendor_id
    b.trackInventory === '0' ? 0 : 1,    // track_inventory
    b.trackBatches === '1' ? 'batches' : 'none',  // adv_tracking
    b.inventoryAccountId || null,         // inventory_account_id
    b.valuation || 'FIFO',                // valuation_method

    b.reorderPoint || 0,                 // reorder_point
    b.hscode || null,                    // hscode
    b.description || null                // description
  ];

  try {
    await queryAsync('START TRANSACTION');

    const result = await queryAsync(insertSql, insertVals);
    const productId = result.insertId;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const relPath = `/uploads/product/${path.basename(f.path)}`;
      await queryAsync(
        `INSERT INTO product_images (product_id, file_path, is_primary, created_at)
         VALUES (?, ?, ?, NOW())`,
        [productId, relPath, i === primaryIndex ? 1 : 0]
      );
    }

    for (const r of openingRows) {
      if (!r || !r.warehouse_id) continue;
      await queryAsync(
        `INSERT INTO product_opening_stock
         (product_id, warehouse_id, qty, unit_cost_per_unit, created_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [productId, r.warehouse_id, r.qty ?? 0, r.unit_cost_per_unit ?? 0]
      );
    }

    await queryAsync('COMMIT');
    res.json({ id: productId, message: 'Product created' });
  } catch (err) {
    await queryAsync('ROLLBACK').catch(() => { });
    await Promise.all((files || []).map(f => fs.promises.unlink(f.path).catch(() => { })));
    console.error('Failed to insert product:', err);
    res.status(500).json({ error: 'Failed to insert product.', details: err.message });
  }
});




//vendor
// 🔹 GET: Tax Treatments
app.get('/api/tax_treatments', (req, res) => {
  db.query('SELECT id, name, tax_number_required  FROM tax_treatment', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// 🔹 GET: Single Tax Treatment by ID
app.get('/api/tax_treatment/:id', (req, res) => {
  const { id } = req.params;
  const sql = 'SELECT * FROM tax_treatment WHERE id = ? LIMIT 1';
  db.query(sql, [id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!results || results.length === 0) {
      return res.status(404).json({ error: 'Tax Treatment not found' });
    }
    res.json(results[0]);
  });
});


// 🔹 GET: Source Supply
app.get('/api/source_supply', (req, res) => {
  db.query('SELECT id, source FROM source_supply', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

//packing
app.get('/api/packings', (req, res) => {
  db.query('SELECT id, name FROM packing', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});


// 🔹 GET: Currency
app.get('/api/currencies', (req, res) => {
  db.query('SELECT id, name FROM currency', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// 🔹 GET: Payment Terms
app.get('/api/payment_terms', (req, res) => {
  db.query('SELECT id, terms FROM payment_terms', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.get('/api/countries', (req, res) => {
  db.query('SELECT id, name FROM country', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.get('/api/states', (req, res) => {
  db.query('SELECT id, name, country_id FROM state', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.get('/api/salutations', (req, res) => {
  db.query('SELECT id, name FROM salutation', (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});


//company settings
// Load company settings (latest one)
app.get('/api/company-settings', (req, res) => {
  db.query(
    `SELECT cs.*, c.id as currency_id, c.name as currency_name, co.id as company_country_id
     FROM company_settings cs
     LEFT JOIN currency c ON cs.base_currency = c.id
     LEFT JOIN country co ON cs.country = co.name -- Join to get country_id from country name
     ORDER BY cs.id DESC LIMIT 1`,
    (err, results) => {
      if (err) return res.status(500).json({ error: err });
      if (results.length > 0) {
        const settings = results[0];
        // Re-shape the base_currency to be the object the frontend expects
        if (settings.currency_id && settings.currency_name) {
          settings.base_currency = {
            value: settings.currency_id,
            label: settings.currency_name
          };
        } else {
          settings.base_currency = null;
        }
        // remove the extra fields to avoid confusion
        delete settings.currency_id;
        delete settings.currency_name;
        res.json(settings);
      } else {
        res.json({});
      }
    });
});

// ✅ GET a specific company's settings by ID
app.get('/api/company-settings/:id', (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Company ID is required' });

  db.query(
    `SELECT cs.*, c.id as currency_id, c.name as currency_name, co.id as company_country_id
     FROM company_settings cs
     LEFT JOIN currency c ON cs.base_currency = c.id
     LEFT JOIN country co ON cs.country = co.name
     WHERE cs.id = ?`,
    [id],
    (err, results) => {
      if (err) return res.status(500).json({ error: err?.sqlMessage || 'Database error' });
      if (results.length > 0) {
        const settings = results[0];
        if (settings.currency_id && settings.currency_name) {
          settings.base_currency = { value: settings.currency_id, label: settings.currency_name };
        } else {
          settings.base_currency = null;
        }
        res.json(settings);
      } else {
        res.status(404).json({ error: 'Company not found' });
      }
    }
  );
});

// ✅ GET all companies for tabbing interface
app.get('/api/companies', (req, res) => {
  db.query(
    `SELECT 
        cs.id, cs.name, cs.industry, cs.logo, 
        cs.country AS country_name, 
        c.id AS country_id 
     FROM company_settings cs
     LEFT JOIN country c ON cs.country = c.name ORDER BY cs.id ASC`,
    (err, results) => {
      if (err) return res.status(500).json({ error: err?.sqlMessage || 'Database error' });
      res.json(results || []);
    }
  );
});

// ✅ DELETE a company by ID
app.delete('/api/company-settings/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Company ID is required' });

  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Check if the company is in use in the vendor table's customer_of field
    // The customer_of field stores a JSON array of company IDs, e.g., '[1, 2]'
    // We use JSON_SEARCH to find if the ID exists in the array. It returns a path string if found, or NULL if not.
    // The previous JSON_SEARCH was incorrect as it searched for a string in an array of numbers.
    // JSON_CONTAINS is the correct function. We check if the numeric ID exists in the array.
    const inUseSql = `SELECT 1 FROM vendor WHERE JSON_CONTAINS(customer_of, ?, '$') LIMIT 1`;
    const [inUseRows] = await conn.query(inUseSql, [id]);

    if (inUseRows.length > 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Cannot delete company. It is currently associated with one or more vendors or customers.' });
    }

    await conn.query('DELETE FROM company_settings WHERE id = ?', [id]);
    await conn.commit();
    res.json({ success: true, message: 'Company deleted successfully.' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err?.sqlMessage || 'Database error during deletion.' });
  } finally {
    conn.release();
  }
});


// Insert company settings
// Insert company settings (accepts logo and/or company_stamp)
app.post('/api/company-settings', uploadCompany, (req, res) => {
  const {
    name, industry, full_address, telephone, fax, country, is_tax_registered, trn_no,
    primary_contact_email, base_currency,
    fiscal_year_id, fiscal_start_day, language_id, timezone_id, date_format_id, company_prefix,
    existing_logo_path // For copying logo
  } = req.body;

  const logoFile = req.files?.logo?.[0] || null;
  const stampFile = req.files?.company_stamp?.[0] || null;

  let final_base_currency = null;
  const raw_currency = req.body.base_currency;

  if (typeof raw_currency === 'object' && raw_currency !== null) {
    // Case 1: It's already an object, e.g., { value: 'USD', label: '...' }
    final_base_currency = raw_currency.value || null;
  } else if (typeof raw_currency === 'string' && raw_currency.trim() && raw_currency !== '[object Object]') {
    // Case 2: It's a string. It could be a primitive 'USD' or a JSON string.
    if (raw_currency.startsWith('{') && raw_currency.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw_currency);
        final_base_currency = parsed.value || null;
      } catch (e) {
        final_base_currency = raw_currency;
      }
    } else {
      final_base_currency = raw_currency;
    }
  }

  let base64logo = null;
  if (logoFile) {
    try {
      const fileBuffer = fs.readFileSync(logoFile.path);
      const ext = path.extname(logoFile.originalname).substring(1) || 'png';
      base64logo = `data:image/${ext};base64,${fileBuffer.toString('base64')}`;
    } catch (err) {
      console.error('Error converting new logo to base64 on create:', err);
    }
  } else if (existing_logo_path) {
    // If copying, generate base64 from the existing file path
    try {
      const fullPath = path.join(__dirname, '..', existing_logo_path);
      if (fs.existsSync(fullPath)) {
        const fileBuffer = fs.readFileSync(fullPath);
        const ext = path.extname(existing_logo_path).substring(1) || 'png';
        base64logo = `data:image/${ext};base64,${fileBuffer.toString('base64')}`;
      }
    } catch (err) {
      console.error('Error converting existing logo to base64 on create:', err);
    }
  }

  const logo = logoFile ? `uploads/company/${logoFile.filename}` : (existing_logo_path || null);
  const company_stamp = stampFile ? `uploads/company/${stampFile.filename}` : null;

  const sql = `
    INSERT INTO company_settings
      (name, industry, full_address, telephone, fax, country, is_tax_registered, trn_no,
       primary_contact_email, base_currency,
       fiscal_year_id, fiscal_start_day, language_id, timezone_id, date_format_id,
       logo, company_stamp, company_prefix, base64logo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    name, industry, full_address, telephone, fax, country, is_tax_registered === '1' ? 1 : 0, trn_no || null,
    primary_contact_email, final_base_currency,
    fiscal_year_id || null, fiscal_start_day || 1, language_id || null, timezone_id || null, date_format_id || null,
    logo, company_stamp, company_prefix || null, base64logo,
  ];

  db.query(sql, params, (err, result) => {
    if (err) return res.status(500).json({ error: err?.sqlMessage || 'Database error' });
    res.json({
      success: true,
      id: result.insertId, // Keep id for frontend logic
      name: name, // Return the saved name
      industry: industry, // Return the saved industry
      logo: logo, // Return the new logo path
      message: 'Company settings saved successfully',
      company_stamp_path: company_stamp // Keep this if used elsewhere
    });
  });
});



app.put('/api/company-settings/:id', uploadCompany, (req, res) => {
  const {
    name, industry, full_address, telephone, fax, country, is_tax_registered, trn_no,
    primary_contact_email, base_currency,
    fiscal_year_id, fiscal_start_day, language_id, timezone_id, date_format_id, company_prefix
  } = req.body;
  const id = req.params.id;

  let final_base_currency = null;
  const raw_currency = req.body.base_currency;

  if (typeof raw_currency === 'object' && raw_currency !== null) {
    // Case 1: It's already an object, e.g., { value: 'USD', label: '...' }
    final_base_currency = raw_currency.value || null;
  } else if (typeof raw_currency === 'string' && raw_currency.trim() && raw_currency !== '[object Object]') {
    // Case 2: It's a string. It could be a primitive 'USD' or a JSON string.
    if (raw_currency.startsWith('{') && raw_currency.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw_currency);
        final_base_currency = parsed.value || null;
      } catch (e) {
        final_base_currency = raw_currency;
      }
    } else {
      final_base_currency = raw_currency;
    }
  }

  const fields = [
    'name = ?', 'industry = ?', 'full_address = ?', 'telephone = ?', 'fax = ?', 'country = ?', 'is_tax_registered = ?', 'trn_no = ?',
    'primary_contact_email = ?', 'base_currency = ?',
    'fiscal_year_id = ?', 'fiscal_start_day = ?', 'language_id = ?', 'timezone_id = ?', 'date_format_id = ?',
    'company_prefix = ?'
  ];
  const values = [
    name, industry, full_address, telephone, fax, country, is_tax_registered === '1' ? 1 : 0, trn_no || null,
    primary_contact_email, final_base_currency,
    fiscal_year_id || null, fiscal_start_day || 1, language_id || null, timezone_id || null, date_format_id || null,
    company_prefix || null,
  ];

  // If logo uploaded (existing behavior with base64logo)
  const logoFile = req.files?.logo?.[0] || null;
  if (logoFile) {
    const logoPath = `uploads/company/${logoFile.filename}`;
    fields.push('logo = ?');
    values.push(logoPath);

    try {
      const fileBuffer = fs.readFileSync(logoFile.path); // Read file from disk path provided by multer
      const ext = path.extname(logoFile.originalname).substring(1) || 'png';
      const base64logo = `data:image/${ext};base64,${fileBuffer.toString('base64')}`;
      fields.push('base64logo = ?');
      values.push(base64logo);
    } catch (err) {
      console.error('Error converting logo to base64 on update:', err);
      // Don't add base64 if conversion fails
    }
  }

  // If company_stamp uploaded (no base64, per your request)
  const stampFile = req.files?.company_stamp?.[0] || null;
  if (stampFile) {
    const stampPath = `uploads/company/${stampFile.filename}`;
    fields.push('company_stamp = ?');
    values.push(stampPath);
  }

  values.push(id);
  const sql = `UPDATE company_settings SET ${fields.join(', ')} WHERE id = ?`;

  db.query(sql, values, (err) => {
    if (err) return res.status(500).json({ error: err?.sqlMessage || 'Database error' });
    res.json({
      success: true,
      message: 'Company settings updated successfully',
      logo: logoFile ? `uploads/company/${logoFile.filename}` : req.body.existing_logo_path || null
    });
  });
});

// ✅ GET email settings
app.get('/api/email-settings', (req, res) => {
  db.query('SELECT * FROM email_settings LIMIT 1', (err, result) => {
    if (err) return res.status(500).send(err);
    if (result.length === 0) return res.send(null);
    res.send(result[0]);
  });
});

// ✅ POST to insert or update
app.post('/api/email-settings', (req, res) => {
  const { username, password, smtp_host, smtp_port, encryption } = req.body;

  db.query('SELECT id FROM email_settings LIMIT 1', (err, result) => {
    if (err) return res.status(500).send(err);

    if (result.length === 0) {
      // INSERT if no settings exist
      db.query(
        'INSERT INTO email_settings (username, password, smtp_host, smtp_port, encryption) VALUES (?, ?, ?, ?, ?)',
        [username, password, smtp_host, smtp_port, encryption],
        (insertErr) => {
          if (insertErr) return res.status(500).send(insertErr);
          res.send({ message: 'Email settings saved.' });
        }
      );
    } else {
      // UPDATE existing settings
      const id = result[0].id;
      db.query(
        'UPDATE email_settings SET username=?, password=?, smtp_host=?, smtp_port=?, encryption=? WHERE id=?',
        [username, password, smtp_host, smtp_port, encryption, id],
        (updateErr) => {
          if (updateErr) return res.status(500).send(updateErr);
          res.send({ message: 'Email settings updated.' });
        }
      );
    }
  });
});

// Routes
//app.use('/api/email-settings', emailRoutes);


//template select
app.get('/api/templatesettings', (req, res) => {
  db.query('SELECT id, title, type, content FROM templatesettings', (err, results) => {
    if (err) return res.status(500).send(err);
    res.json(results);
  });
});

//template insert
app.post('/api/templatesettings', (req, res) => {
  const { title, type, content } = req.body;

  if (!title || !type || !content) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const query = 'INSERT INTO templatesettings (title, type, content) VALUES (?, ?, ?)';
  db.query(query, [title, type, content], (err, result) => {
    if (err) {
      console.error('Insert error:', err);
      return res.status(500).json({ error: 'Database insert failed' });
    }
    res.json({ success: true, id: result.insertId });
  });
});

// ✅ PUT update template
app.put('/api/templatesettings/:id', (req, res) => {
  const { title, type, content } = req.body;
  const { id } = req.params;

  if (!title || !type || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const query = `UPDATE templatesettings SET title = ?, type = ?, content = ? WHERE id = ?`;
  db.query(query, [title, type, content, id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Update failed', details: err });
    res.json({ message: 'Template updated' });
  });
});


//preference


/** vendor common
 * Preferences (kept as-is for vendors)
 * GET  /api/preferences/vendor
 * POST /api/preferences/vendor
 */

/**
 * DELETE /api/vendor_attachments/:id
 */
app.delete("/api/vendor_attachments/:id", (req, res) => {
  const { id } = req.params;

  db.query("DELETE FROM vendor_attachment WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: "Failed to delete attachment" });
    res.json({ success: true, message: "Attachment deleted" });
  });
});


app.get("/api/preferences/vendor", async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const [rows] = await db
      .promise()
      .query(
        "SELECT acc_address_open, acc_details_open, acc_contacts_open, acc_record_open FROM user_vendor_preferences WHERE user_id = ? LIMIT 1",
        [userId]
      );

    if (rows.length > 0) {
      res.json(rows[0]);
    } else {
      res.json({
        acc_address_open: true,
        acc_details_open: true,
        acc_contacts_open: true,
        acc_record_open: true
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch preferences", details: err.message });
  }
});

app.post("/api/preferences/vendor", async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { acc_address_open, acc_details_open, acc_contacts_open, acc_record_open } = req.body;

  try {
    const [existing] = await db
      .promise()
      .query("SELECT id FROM user_vendor_preferences WHERE user_id = ?", [userId]);

    if (existing.length > 0) {
      await db
        .promise()
        .query(
          `UPDATE user_vendor_preferences
           SET acc_address_open = ?, acc_details_open = ?, acc_contacts_open = ?, acc_record_open = ?
           WHERE user_id = ?`,
          [acc_address_open, acc_details_open, acc_contacts_open, acc_record_open, userId]
        );
    } else {
      await db
        .promise()
        .query(
          `INSERT INTO user_vendor_preferences (user_id, acc_address_open, acc_details_open, acc_contacts_open, acc_record_open)
           VALUES (?, ?, ?, ?, ?)`,
          [userId, acc_address_open, acc_details_open, acc_contacts_open, acc_record_open]
        );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save preferences", details: err.message });
  }
});

/**
 * POST /api/vendor-contacts
 * PUT  /api/vendor-contacts/:id
 */
app.post("/api/vendor-contacts", async (req, res) => {
  const {
    vendor_id,
    salutation,
    first_name,
    last_name,
    email,
    phone,
    mobile,
    skype_name_number,
    designation,
    department
  } = req.body;

  const sql = `INSERT INTO vendor_contact
    (vendor_id, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.query(
    sql,
    [
      vendor_id,
      salutation,
      first_name,
      last_name,
      email,
      phone,
      mobile,
      skype_name_number,
      designation,
      department
    ],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.status(200).json({ message: "Contact added" });
    }
  );
});

app.put("/api/vendor-contacts/:id", (req, res) => {
  const {
    salutation,
    first_name,
    last_name,
    email,
    phone,
    mobile,
    skype_name_number,
    designation,
    department
  } = req.body;
  const id = req.params.id;

  const sql = `UPDATE vendor_contact SET
    salutation_id = ?, first_name = ?, last_name = ?, email = ?,
    phone = ?, mobile = ?, skype_name_number = ?, designation = ?, department = ?
    WHERE id = ?`;

  db.query(
    sql,
    [
      salutation,
      first_name,
      last_name,
      email,
      phone,
      mobile,
      skype_name_number,
      designation,
      department,
      id
    ],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Contact updated" });
    }
  );
});

// ✅ GET Business Types
app.get('/api/business-types', async (req, res) => {
  try {
    const [rows] = await db.promise().query('SELECT id, name FROM business_types WHERE is_active = 1 ORDER BY sort_order, name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load business types' }); }
});

// ✅ GET Product Interests
app.get('/api/product-interests', async (req, res) => {
  try {
    const [rows] = await db.promise().query('SELECT id, name FROM product_interests WHERE is_active = 1 ORDER BY sort_order, name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load product interests' }); }
});

// ✅ Global error handler (JSON response for API)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const message =
    err.sqlMessage ||
    err.message ||
    'Internal Server Error';

  console.error('API Error:', {
    status,
    message,
    path: req.originalUrl,
    method: req.method
  });

  res.status(status).json({ error: message });
});

// ✅ START SERVER
// server/server.js (Render)
const PORT = process.env.PORT || 5700;

// Add error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  // Don't exit in production - let Render handle it
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit in production - let Render handle it
});

// Test database connection before starting server
db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
    // Don't exit - let the server start and handle errors gracefully
  } else {
    console.log('✅ Database connection successful');
    connection.release();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server started successfully on port ${PORT}`);
  console.log(`✅ Health check available at: http://0.0.0.0:${PORT}/`);
  console.log(`✅ API health check at: http://0.0.0.0:${PORT}/api/health`);
});