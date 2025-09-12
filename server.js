import express from 'express';
import mysql from 'mysql2';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import session from 'express-session';
import emailRoutes from './routes/emailRoutes.js';
import productRoutes from './routes/products.js';
import customerRoutes from './routes/customer.js';
import vendorRoutes from './routes/vendor.js';
import purchaseorderRoutes from './routes/purchaseorder.js';
import portRoutes from './routes/port.js';
import incoRoutes from './routes/inco.js';
import uomRoutes from './routes/uom.js';
import statusRoutes from './routes/status.js';
import termsconditionRoutes from './routes/termscondition.js';
import taxesRoutes from './routes/taxes.js';
import shipmentRoutes from './routes/shipment.js';
import proformaRoutes from './routes/proforma.js';
import documentTypeRoutes from './routes/documentType.js';
import shipmentDocumentsRoutes from './routes/shipmentDocuments.js';
import shipmentStageRoutes from './routes/shipmentStage.js';
import modeShipmentRoutes from './routes/modeShipment.js';
import bankRoutes from './routes/bank.js';
import partialShipmentRoutes from './routes/partialShipment.js';
import containerTypeRoutes from './routes/containerType.js';
import containerLoadRoutes from './routes/containerLoad.js';
import documentRoutes from './routes/document.js';
import brandRoutes from './routes/brand.js';
import manufactureRoutes from './routes/manufacture.js';
import './cronJobs/expireCheck.js';
import masterRoutes from "./routes/master.js";
import warehousesRoutes from "./routes/warehouses.js";
import router from "./routes/customer.js"; // ✅ ES module import


const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


//session
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
}));

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

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/signatures");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    },
});
const uploadSignature = multer({ storage });



const upload = multer({ storage: productStorage });
const uploadv = multer({ storage: vendorStorage });
const uploadc = multer({ storage: companyStorage });

const uploadCompany = uploadc.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'company_stamp', maxCount: 1 }
]);


/* ---------- Helpers ---------- */
const likeWrap = (s = '') => `%${s || ''}%`;

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'portal_db'
});

db.connect(err => {
  if (err) {
    console.error('❌ MySQL connection failed:', err);
    process.exit(1);
  }
  console.log('✅ Connected to MySQL database');
});




// ✅ HEALTH CHECK
app.get('/', (req, res) => {
  res.json({ success: true, message: 'API running' });
});

app.use("/api/purchaseorder", purchaseorderRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/vendors", vendorRoutes);
app.use("/api/ports", portRoutes);
app.use("/api/mode-shipment", modeShipmentRoutes);
app.use("/api/incoterms", incoRoutes);
app.use("/api/uoms", uomRoutes);
app.use("/api/termscondition", termsconditionRoutes);
app.use("/api/taxes", taxesRoutes);
app.use("/api/status", statusRoutes);
app.use("/api/shipment", shipmentRoutes);
app.use("/api/document-types", documentTypeRoutes);
app.use("/api/shipment-documents", shipmentDocumentsRoutes);
app.use("/api/shipment-stages", shipmentStageRoutes);
app.use("/api/proforma", proformaRoutes);
app.use("/api/bank", bankRoutes);
app.use("/api/partial-shipment", partialShipmentRoutes);
app.use("/api/container-type", containerTypeRoutes);
app.use("/api/container-load", containerLoadRoutes);
app.use("/api/document", documentRoutes);
app.use("/api/brand", brandRoutes);
app.use("/api/manufacture", manufactureRoutes);
app.use("/api/master", masterRoutes);
app.use("/api/warehouses", warehousesRoutes);


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
            GROUP_CONCAT(DISTINCT p.name) AS provision_names,
            MAX(u.signature_path) AS signature_path
        FROM \`user\` u
                 LEFT JOIN department d ON d.id = u.department_id
                 LEFT JOIN provision p ON FIND_IN_SET(p.id, IFNULL(u.provision, ''))
        WHERE u.is_inactive = 0
        GROUP BY
            u.id, u.name, u.designation, u.email, u.password, u.department_id, d.name
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
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.query(
    'SELECT * FROM user WHERE email = ? AND password = ? AND is_inactive = 0',
    [email, password],
    (err, results) => {
      if (err) {
        console.error('❌ Login error:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (results.length === 0) {
        return res.json({ success: false, message: 'Invalid credentials' });
      }
      //res.json({ success: true, user: results[0] });
      req.session.user = { id: results[0].id, email: results[0].email };
      res.json({ success: true, user: req.session.user });
    }
  );
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
app.post("/api/user", uploadSignature.single("signature"), (req, res) => {
    const { name, designation, department_id, provision, email, password } =
        req.body;
    const signaturePath = req.file
        ? `/uploads/signatures/${req.file.filename}`
        : null;

    const sql = `
    INSERT INTO \`user\`
      (name, designation, department_id, provision, email, password, signature_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

    db.query(
        sql,
        [name, designation, department_id, provision, email, password, signaturePath],
        (err, result) => {
            if (err) {
                console.error("SQL ERROR (POST /api/user):", err);
                return res
                    .status(500)
                    .json({ success: false, error: err.message });
            }
            res.json({ success: true, id: result.insertId });
        }
    );
});

// === UPDATE USER ===
app.put("/api/user/:id", uploadSignature.single("signature"), (req, res) => {
    const { id } = req.params;
    const { name, designation, department_id, provision, email, password } =
        req.body;

    const selSql =
        "SELECT password, signature_path FROM `user` WHERE id = ?";
    db.query(selSql, [id], (selErr, rows) => {
        if (selErr) {
            console.error("SQL ERROR (select current user):", selErr);
            return res
                .status(500)
                .json({ success: false, error: selErr.message });
        }
        if (!rows || rows.length === 0) {
            return res
                .status(404)
                .json({ success: false, error: "User not found" });
        }

        const currentPassword = rows[0].password;
        const currentSignature = rows[0].signature_path;

        // Keep old password if empty string
        const nextPassword =
            password && password.trim() !== ""
                ? password
                : currentPassword;

        // Signature logic
        let nextSignaturePath = currentSignature;
        if (req.file) {
            nextSignaturePath = `/uploads/signatures/${req.file.filename}`;

            // Delete old file if exists
            if (currentSignature) {
                try {
                    const abs = path.join(
                        __dirname,
                        currentSignature.replace(/^[\\/]/, "")
                    );
                    if (fs.existsSync(abs)) fs.unlinkSync(abs);
                } catch (e) {
                    console.warn("Delete old signature failed:", e.message);
                }
            }
        }

        const updSql = `
      UPDATE \`user\`
      SET name = ?, designation = ?, department_id = ?, provision = ?, email = ?, password = ?, signature_path = ?
      WHERE id = ?
    `;
        const params = [
            name,
            designation,
            department_id,
            provision,
            email,
            nextPassword,
            nextSignaturePath,
            id,
        ];

        db.query(updSql, params, (updErr) => {
            if (updErr) {
                console.error("SQL ERROR (PUT /api/user/:id):", updErr);
                return res
                    .status(500)
                    .json({ success: false, error: updErr.message });
            }
            return res.json({ success: true });
        });
    });
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
        units:         'SELECT id, name as unit_name FROM uom_master ORDER BY name',
        brands:        'SELECT id, brand_name FROM brands ORDER BY brand_name',
        manufacturers: 'SELECT id, name FROM manufacturers ORDER BY name',
        accounts:      'SELECT id, account_name, type FROM accounts ORDER BY account_name',
        warehouses:    'SELECT id, warehouse_name FROM warehouses ORDER BY warehouse_name',
        vendors:       'SELECT id, display_name FROM vendor ORDER BY display_name',
        taxes:         "SELECT id, tax_name, rate, type FROM taxes WHERE is_active=1 ORDER BY tax_name",
        valuations:    "SELECT id, code, method_name FROM valuation_methods WHERE is_active = 1 ORDER BY sort_order, method_name"
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


// (optional) quick health check
app.get('/api/health', (req, res) => {
    db.query('SELECT 1', (err) => {
        if (err) return res.status(500).json({ ok: false, message: err.message });
        res.json({ ok: true });
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
    } catch {}

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
        await queryAsync('ROLLBACK').catch(() => {});
        await Promise.all((files || []).map(f => fs.promises.unlink(f.path).catch(() => {})));
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
  db.query('SELECT * FROM company_settings ORDER BY id DESC LIMIT 1', (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results[0] || {});
  });
});

// Insert company settings
// Insert company settings (accepts logo and/or company_stamp)
app.post('/api/company-settings', uploadCompany, (req, res) => {
    const { name, full_address, telephone, fax, country } = req.body;

    const logoFile  = req.files?.logo?.[0] || null;
    const stampFile = req.files?.company_stamp?.[0] || null;

    const logo = logoFile ? `uploads/company/${logoFile.filename}` : null;
    const company_stamp = stampFile ? `uploads/company/${stampFile.filename}` : null;

    const sql = `
    INSERT INTO company_settings
      (name, full_address, telephone, fax, country, logo, company_stamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
    const params = [name, full_address, telephone, fax, country, logo, company_stamp];

    db.query(sql, params, (err, result) => {
        if (err) return res.status(500).json({ error: err?.sqlMessage || 'Database error' });
        res.json({
            success: true,
            id: result.insertId,
            message: 'Company settings saved successfully',
            logo_path: logo,
            company_stamp_path: company_stamp
        });
    });
});



app.put('/api/company-settings/:id', uploadCompany, (req, res) => {
    const { name, full_address, telephone, fax, country } = req.body;
    const id = req.params.id;

    const fields = [
        'name = ?',
        'full_address = ?',
        'telephone = ?',
        'fax = ?',
        'country = ?'
    ];
    const values = [name, full_address, telephone, fax, country];

    // If logo uploaded (existing behavior with base64logo)
    const logoFile = req.files?.logo?.[0] || null;
    if (logoFile) {
        const logoPath = `uploads/company/${logoFile.filename}`;
        fields.push('logo = ?');
        values.push(logoPath);

        try {
            const fileBuffer = fs.readFileSync(logoFile.path);
            const ext = path.extname(logoFile.originalname).substring(1) || 'png';
            const base64logo = `data:image/${ext};base64,${fileBuffer.toString('base64')}`;
            fields.push('base64logo = ?');
            values.push(base64logo);
        } catch (err) {
            console.error('❌ Error converting logo to base64:', err);
            return res.status(500).json({ error: 'Failed to process uploaded logo.' });
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
        res.json({ success: true, message: 'Company settings updated successfully' });
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
app.use('/api/email-settings', emailRoutes);


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

// ✅ START SERVER
const PORT = process.env.PORT || 5641;
app.listen(PORT, '127.0.0.1', () => console.log(`API on http://127.0.0.1:${PORT}`));

