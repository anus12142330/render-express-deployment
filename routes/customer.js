import express from 'express';
import db from '../db.js';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const errPayload = (message, type = 'APP_ERROR', hint) => ({ error: { message, type, hint } });

// ---- harden inserts + logging
const toNull = v => (v === '' || v === undefined ? null : v);
const mustArray = v => {
    try { return Array.isArray(v) ? v : JSON.parse(v || '[]'); }
    catch { return []; }
};

// Accepts many shapes and outputs the canonical DB shape
const normalizeShipAddr = (raw = {}) => {
    // Accept both “ship_*” and generic keys from the modal/list
    const get = (...keys) => {
        for (const k of keys) {
            if (raw[k] !== undefined && raw[k] !== null) return raw[k];
        }
        return undefined;
    };

    return {
        ship_attention: get('ship_attention', 'attention', 'address_label'),
        ship_address_1: get('ship_address_1', 'address', 'address_1'),
        ship_address_2: get('ship_address_2', 'street2', 'address_2'),
        ship_city: get('ship_city', 'city'),
        ship_state_id: toNull(get('ship_state_id', 'state', 'state_id')),
        ship_zip_code: get('ship_zip_code', 'zip', 'zipcode'),
        ship_country_id: toNull(get('ship_country_id', 'country', 'country_id')),
        ship_phone: get('ship_phone', 'phone'),
        ship_fax: get('ship_fax', 'fax'),
        is_primary: get('is_primary') ? 1 : 0,
        // New delivery fields
        latitude: get('latitude'),
        longitude: get('longitude'),
        place_name: get('place_name'),
        formatted_address: get('formatted_address'),
        place_id: get('place_id'),
        available_time_ids: Array.isArray(get('available_time_ids')) ? get('available_time_ids').join(',') : get('available_time_ids'),
        delivery_window: get('delivery_window'),
    };
};

// ---------- FS helpers ----------
const ensureDir = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch { } };
ensureDir('uploads/customer');



// helpers for robust parsing (accept both numeric and legacy strings)
const asIntCustomerType = (v) => (v === 1 || v === '1' || v === 'business') ? 1 : 0; // 1=business, 0=individual

// ---------- Multer ----------
const customerStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, 'uploads/customer'),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        const name = crypto.randomBytes(16).toString('hex');
        cb(null, name + ext);
    }
});
const uploadCustomer = multer({ storage: customerStorage });

// ---------- NEW semantics ----------
/**
 * company_type_id: 'customer' | 'vendor'
 * customer_type:   'individual' | 'business'
 *
 * If your DB stores ints instead of strings, change these constants accordingly.
 */
const COMPANY_TYPE_CUSTOMER = '2';

// Utility
const like = (s = '') => `%${s}%`;

/* ================================
   GET /api/customers/full
================================ */
router.get('/full', async (req, res) => {
    const { search = '' } = req.query;
    try {
        const [rows] = await db.promise().query(
            `
      SELECT v.id, v.display_name AS name, v.uniqid
      FROM vendor v
      WHERE v.company_type_id = ?
        AND (v.display_name LIKE ? OR v.company_name LIKE ?)
      ORDER BY v.display_name ASC
      LIMIT 100
      `,
            [COMPANY_TYPE_CUSTOMER, like(search), like(search)]
        );
        res.json(rows);
    } catch (err) {
        console.error('customers/full:', err);
        res.status(500).json(errPayload('Failed to load customers', 'DB_ERROR', err.message));
    }
});

/* ================================
   GET /api/customers
================================ */
router.get('/', async (req, res) => {
    const limit = parseInt(req.query.limit || 25, 10);
    const offset = parseInt(req.query.offset || 0, 10);
    const search = String(req.query.search || '');
    const userId = req.query.user_id;

    try {
        const [data] = await db.promise().query(
            `
      SELECT
        v.id,
        v.uniqid,
        v.display_name AS name,
        v.company_name,
        v.email_address AS email,
        v.phone_work,
        v.customer_type,      -- 'individual' | 'business'
        0 AS payables,
        0 AS unused_credits,
        (
          SELECT COUNT(*) FROM vendor_attachment va
          WHERE va.vendor_id = v.id AND va.expiry_date < CURDATE()
        ) AS expired_attachments_count
      FROM vendor v
      WHERE v.company_type_id = ?
        AND (
          v.display_name LIKE ? OR
          v.company_name LIKE ? OR
          v.email_address LIKE ? OR
          v.phone_work LIKE ?
        )
        ${userId ? 'AND v.user_id = ?' : ''}
      ORDER BY v.display_name ASC
      LIMIT ? OFFSET ?
      `,
            [COMPANY_TYPE_CUSTOMER, like(search), like(search), like(search), like(search)]
                .concat(userId ? [userId] : [])
                .concat([limit, offset])
        );

        const [countRows] = await db.promise().query(
            `
      SELECT COUNT(*) AS total
      FROM vendor v
      WHERE v.company_type_id = ?
        AND (
          v.display_name LIKE ? OR
          v.company_name LIKE ? OR
          v.email_address LIKE ? OR
          v.phone_work LIKE ?
        )
        ${userId ? 'AND v.user_id = ?' : ''}
      `,
            [COMPANY_TYPE_CUSTOMER, like(search), like(search), like(search), like(search)].concat(userId ? [userId] : [])
        );

        res.json({ data, total: countRows[0]?.total || 0 });
    } catch (err) {
        console.error('customers list:', err);
        res.status(500).json(errPayload('Failed to load customers', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers
================================ */
router.post('/', uploadCustomer.array('attachments'), async (req, res) => {
    const {
        company_name, display_name, email_address, phone_work, phone_mobile, remarks,
        tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id,
        business_type_other, outlets_count, avg_weekly_purchase, has_cold_storage,
        bill_attention, bill_country_id, bill_address_1, bill_address_2, bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax, customer_of,
        customer_type // 'individual' | 'business'
    } = req.body;

    const uniqid = `cus_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const userId = req.session?.user?.id || null;
    const files = req.files || [];
    const tagsRaw = req.body.tags;


    let contactPersons = [];
    try {
        contactPersons = JSON.parse(req.body.contactPersons || '[]');
    } catch (e) {
        return res.status(400).json(errPayload('Invalid contactPersons JSON'));
    }

    const conn = await db.promise().getConnection();
    try {
        // 1) Log raw body once
        console.log('[CREATE] body keys:', Object.keys(req.body));

        // Safely parse arrays of IDs from the form
        const business_types_ids = mustArray(req.body.business_types);
        const product_interests_ids = mustArray(req.body.product_interests);
        const notification_prefs = mustArray(req.body.notification_prefs)[0] || {}; // Assuming it's not an array
        let safeCustomerOf = (Array.isArray(customer_of) ? customer_of.join(',') : String(customer_of || ''))
            .split(',').map(s => s.trim()).filter(Boolean).join(',');

        // If customer_of is not provided, check if there's only one company
        if (!safeCustomerOf) {
            const [companies] = await conn.query('SELECT id FROM company_settings');
            if (companies.length === 1) {
                safeCustomerOf = String(companies[0].id);
            }
        }
        const safeTags = typeof tagsRaw === 'string' ? tagsRaw : JSON.stringify(tagsRaw || []);

        await conn.beginTransaction();

        // Insert core record (shared "vendor" table)
        const [ins] = await conn.query(
            `
      INSERT INTO vendor
        (company_name, display_name, email_address, phone_work, phone_mobile, tags, remarks,
         uniqid, user_id, updated_user, company_type_id, customer_type, customer_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
            [
                company_name, display_name, email_address, phone_work, phone_mobile, safeTags, remarks, uniqid, userId,
                userId, COMPANY_TYPE_CUSTOMER, asIntCustomerType(customer_type), safeCustomerOf,
            ]
        );
        const customerId = ins.insertId;

        await conn.query(
            `INSERT INTO vendor_other
         (vendor_id, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id,
          business_type_other, outlets_count, avg_weekly_purchase, has_cold_storage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [customerId, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id,
                business_type_other, outlets_count, avg_weekly_purchase, has_cold_storage
            ]
        );

        await conn.query(
            `INSERT INTO vendor_address (
         vendor_id, bill_attention, bill_country_id, bill_address_1, bill_address_2,
         bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                customerId, bill_attention, bill_country_id, bill_address_1, bill_address_2, bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax
            ]
        );

        // INSERT shipping addresses
        const rawShippingAddresses = mustArray(req.body.shipping_addresses || '[]');
        for (const rawAddr of rawShippingAddresses) {
            const addr = normalizeShipAddr(rawAddr);
            await conn.query(
                `INSERT INTO vendor_shipping_addresses
                 (vendor_id, ship_attention, ship_address_1, ship_address_2, ship_city, ship_state_id, ship_zip_code, ship_country_id, ship_phone, ship_fax, is_primary,
                  latitude, longitude, place_name, formatted_address, place_id, available_time_ids, delivery_window)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`,
                [
                    customerId, // This is the insertId from the 'vendor' table
                    addr.ship_attention || null,
                    addr.ship_address_1 || null,
                    addr.ship_address_2 || null,
                    addr.ship_city || null,
                    addr.ship_state_id,
                    addr.ship_zip_code || null,
                    addr.ship_country_id,
                    addr.ship_phone || null,
                    addr.ship_fax || null,
                    addr.is_primary,
                    addr.latitude || null,
                    addr.longitude || null,
                    addr.place_name || null,
                    addr.formatted_address || null,
                    addr.place_id || null,
                    addr.available_time_ids || null,
                    addr.delivery_window || null,
                ]
            );
        }

        // Insert into new linking tables
        if (Array.isArray(business_types_ids) && business_types_ids.length > 0) {
            const businessTypeValues = business_types_ids.map(id => [customerId, id]);
            await conn.query('INSERT INTO customer_business_types (customer_id, business_type_id) VALUES ?', [businessTypeValues]);
        }

        if (Array.isArray(product_interests_ids) && product_interests_ids.length > 0) {
            const productInterestValues = product_interests_ids.map(id => [customerId, id]);
            await conn.query('INSERT INTO customer_product_interests (customer_id, product_interest_id) VALUES ?', [productInterestValues]);
        }

        // Insert notification preferences
        const notificationValues = [];
        for (const type in notification_prefs) {
            for (const channel in notification_prefs[type]) {
                const value = notification_prefs[type][channel];
                if (value) { // Only insert if there's a value
                    notificationValues.push([customerId, type, channel, value]);
                }
            }
        }
        if (notificationValues.length > 0) {
            await conn.query('INSERT INTO customer_notification_settings (customer_id, notification_type, channel, value) VALUES ?', [notificationValues]);
        }


        const fullAddress = [bill_address_1, bill_address_2, bill_city, bill_zip_code].filter(Boolean).join(', ');

        for (const p of contactPersons) {
            await conn.query(
                `INSERT INTO contact
           (vendor_id, is_primary, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department, customer_name, address, company_type_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    customerId,
                    p.is_primary ? 1 : 0,
                    p.salutation_id, p.first_name, p.last_name,
                    p.email, p.phone, p.mobile,
                    p.skype_name_number, p.designation, p.department,
                    display_name,
                    fullAddress,
                    COMPANY_TYPE_CUSTOMER
                ]
            );
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const expiry = req.body[`attachment_expiry_${i}`] || null; // "YYYY-MM-DD" from UI
            const docTypeId = req.body[`attachment_doctype_${i}`] || null;

            await conn.query(
                `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date, document_type_id)
                 VALUES (?, ?, ?, ?, ?)`,
                [customerId, (f.path || '').replace(/\\/g, '/'), f.originalname, expiry, docTypeId]
            );
        }

        // History Logging
        await conn.query(
            `INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, ?, ?)`,
            [customerId, userId, 'CREATED', JSON.stringify({ name: display_name })]
        );

        await conn.commit();
        return res.json({ ok: true, customerId, uniqid, shipping_inserted: rawShippingAddresses.length });
    } catch (err) {
        await conn.rollback();
        console.error('[CREATE][ERROR]', err);
        return res.status(400).json({ ok: false, error: String(err) });
    } finally {
        conn.release();
    }
});

/* ================================
   POST /api/customers/quick-add
================================ */
router.post('/quick-add', async (req, res) => {
    const {
        name, // from the form, maps to company_name
        display_name,
        tax_treatment_id,
        tax_registration_number,
        bill_country_id,
    } = req.body;

    const userId = req.session?.user?.id || null;

    // --- Validation ---
    if (!display_name?.trim()) return res.status(400).json(errPayload('Display Name is required.'));
    if (!tax_treatment_id) return res.status(400).json(errPayload('Tax Treatment is required.'));
    // You can add more validation here if needed

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const uniqid = `cus_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

        // Insert into the main 'vendor' table, which is used for customers
        const [ins] = await conn.query(
            `INSERT INTO vendor (uniqid, company_name, display_name, user_id, company_type_id, customer_type) VALUES (?, ?, ?, ?, ?, ?)`,
            [uniqid, name || display_name, display_name, userId, COMPANY_TYPE_CUSTOMER, 'business']
        );
        const customerId = ins.insertId;

        // Insert into the 'vendor_other' table for tax details
        await conn.query(
            `INSERT INTO vendor_other (vendor_id, tax_treatment_id, tax_registration_number) VALUES (?, ?, ?)`,
            [customerId, tax_treatment_id, tax_registration_number || null]
        );

        // Insert into the 'vendor_address' table for billing country
        await conn.query(
            `INSERT INTO vendor_address (vendor_id, bill_country_id) VALUES (?, ?)`,
            [customerId, bill_country_id || null]
        );

        await conn.commit();

        // Return the new customer object so the frontend can use it immediately
        res.status(201).json({ id: customerId, uniqid, name: display_name, display_name });

    } catch (err) {
        await conn.rollback();
        console.error('Quick create customer failed:', err);
        res.status(500).json(errPayload('Quick create failed', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   GET /api/customers/:uniqid/full
================================ */
router.get('/:identifier/full', async (req, res) => {
    const { identifier } = req.params;

    try {
        // Determine if the identifier is a numeric ID or a string uniqid
        const isNumericId = /^\d+$/.test(identifier);
        const column = isNumericId ? 'v.id' : 'v.uniqid';
        const params = [identifier, COMPANY_TYPE_CUSTOMER];

        const [rows] = await db.promise().query(
            `
      SELECT 
        v.*,
        currency.name AS currency_name,
        pt.terms AS payment_terms,
        tax_treatment.name AS tax_name,
        vo.tax_treatment_id,
        vo.tax_registration_number,
        vo.source_supply_id,
        vo.currency_id,
        vo.payment_terms_id,
        va.bill_attention,
        va.bill_country_id,
        va.bill_address_1,
        va.bill_address_2,
        va.bill_city,
        va.bill_state_id,
        va.bill_zip_code,
        va.bill_phone,
        va.bill_fax,
        vo.business_type_other,
        vo.outlets_count,
        vo.avg_weekly_purchase,
        vo.has_cold_storage,
        CONCAT_WS(', ', va.bill_address_1, va.bill_address_2, va.bill_city, va.bill_zip_code) AS billing_address,
        (SELECT GROUP_CONCAT(business_type_id) FROM customer_business_types WHERE customer_id = v.id) as business_types,
        (SELECT GROUP_CONCAT(product_interest_id) FROM customer_product_interests WHERE customer_id = v.id) as product_interests,
        bill_state.name AS bill_state_name,
        bill_country.name AS bill_country_name,
        -- Removed single shipping address fields, they will be fetched separately
        (
          SELECT COUNT(*)
          FROM vendor_attachment
          WHERE vendor_id = v.id AND expiry_date < CURDATE()
        ) AS expired_attachments_count,
        (
          SELECT JSON_OBJECT(
            'id', r.id, 
            'credit_limit', r.credit_limit, 
            'credit_terms', r.credit_terms, 
            'status_id', r.status_id,
            'requested_at', r.requested_at
          ) 
          FROM customer_credit_limit_requests r 
          WHERE r.customer_id = v.id AND r.status_id IN (1, 2, 3, 8) -- 1:Approved, 2:Rejected, 3:Draft, 8:Pending
          ORDER BY r.id DESC 
          LIMIT 1
        ) as pending_credit_request
      FROM vendor v
      LEFT JOIN vendor_other vo ON v.id = vo.vendor_id
      LEFT JOIN vendor_address va ON v.id = va.vendor_id
      LEFT JOIN currency ON currency.id = vo.currency_id
      LEFT JOIN payment_terms pt ON pt.id = vo.payment_terms_id
      LEFT JOIN tax_treatment ON tax_treatment.id = vo.tax_treatment_id
      LEFT JOIN state AS bill_state ON bill_state.id = va.bill_state_id
      LEFT JOIN country AS bill_country ON bill_country.id = va.bill_country_id
      WHERE ${column} = ? AND v.company_type_id = ?
      `,
            params
        );

        if (!rows.length) return res.status(404).json(errPayload('Customer not found', 'NOT_FOUND'));

        const customerData = rows[0];
        const id = customerData.id;

        // Fetch notification settings separately
        const [notificationRows] = await db.promise().query('SELECT notification_type, channel, value FROM customer_notification_settings WHERE customer_id = ?', [id]);
        const notification_prefs = {};
        notificationRows.forEach(row => {
            if (!notification_prefs[row.notification_type]) {
                notification_prefs[row.notification_type] = {};
            }
            notification_prefs[row.notification_type][row.channel] = row.value;
        });

        // Convert the comma-separated string from DB back to an array for the frontend
        const customer = {
            ...customerData,
            customer_of: (customerData.customer_of || '').split(',').map(s => s.trim()).filter(Boolean),
            // Safely parse comma-separated strings from GROUP_CONCAT
            business_types: (customerData.business_types || '').split(',').filter(id => id).map(Number),
            product_interests: (customerData.product_interests || '').split(',').filter(id => id).map(Number),
            has_cold_storage: String(customerData.has_cold_storage ?? '0'),
            outlets_count: customerData.outlets_count ?? '',
            avg_weekly_purchase: customerData.avg_weekly_purchase ?? '',
            notification_prefs: notification_prefs,
            pending_credit_request: customerData.pending_credit_request ? JSON.parse(customerData.pending_credit_request) : null,
        };

        const [shipping_addresses] = await db.promise().query(
            `SELECT 
                csa.*,
                s.name as ship_state_name,
                c.name as ship_country_name
             FROM vendor_shipping_addresses csa
             LEFT JOIN state s ON s.id = csa.ship_state_id 
             LEFT JOIN country c ON c.id = csa.ship_country_id 
             WHERE csa.vendor_id = ? 
             ORDER BY csa.is_primary DESC, csa.id ASC`,
            [id]
        );

        customer.shipping_addresses = shipping_addresses || [];

        const [contacts] = await db.promise().query(
            `
            SELECT 
                c.*,
                s.name as salutation_name
            FROM contact c
            LEFT JOIN salutation s ON c.salutation_id = s.id
            WHERE c.vendor_id = ?`,
            [id]
        );
        const [attachments] = await db.promise().query(
            `SELECT va.*, dt.name as document_type_name FROM vendor_attachment va LEFT JOIN kyc_documents dt ON va.document_type_id = dt.id WHERE va.vendor_id = ? ORDER BY va.id DESC`,
            [id]
        );
        const [transactions] = await db.promise().query(
            // This table likely doesn't exist, using a placeholder.
            // Using proforma_invoice as the source for customer transactions.
            `SELECT * FROM proforma_invoice WHERE buyer_id = ?`,
            [id]
        );
        const [history] = await db.promise().query(
            `
            SELECT
                vh.id,
                vh.action,
                vh.details,
                vh.created_at,
                u.name AS user_name
            FROM vendor_history vh
            LEFT JOIN user u ON u.id = vh.user_id
            WHERE vh.vendor_id = ? ORDER BY vh.created_at DESC`,
            [id]
        );

        res.json({ customer, contacts, attachments, transactions: transactions || [], history: history || [] });
    } catch (err) {
        console.error(`customers/:${req.params.identifier}/full:`, err);
        res.status(500).json(errPayload('Failed to load customer', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers/upload
================================ */
router.post('/upload', uploadCustomer.single('file'), async (req, res) => {
    const { customer_id, expiry_date, document_type_id } = req.body;
    const file = req.file;
    if (!file || !customer_id) return res.status(400).json(errPayload('Missing file or customer_id'));

    try {
        await db.promise().query(
            `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date, document_type_id)
       VALUES (?, ?, ?, ?, ?)`,
            [customer_id, file.path, file.originalname, expiry_date || null, document_type_id || null]
        );
        res.json({ success: true, message: 'File uploaded successfully' });
    } catch (err) {
        console.error('customers/upload:', err);
        res.status(500).json(errPayload('Upload failed', 'DB_ERROR', err.message));
    }
});

/* ================================
   PUT /api/customers/:id
================================ */
router.put('/:id', uploadCustomer.array('attachments'), async (req, res) => {
    const customerId = req.params.id;
    const userId = req.session?.user?.id || null;

    let deletedAttachmentIds = [];
    let contactPersons = [];
    try {
        deletedAttachmentIds = JSON.parse(req.body.deletedAttachmentIds || '[]');
        contactPersons = JSON.parse(req.body.contactPersons || '[]');
    } catch {
        return res.status(400).json(errPayload('Invalid JSON in request body', 'BAD_REQUEST'));
    }

    const {
        company_name, display_name, email_address, phone_work, phone_mobile, remarks, website,
        tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id,
        business_type_other, outlets_count, avg_weekly_purchase, has_cold_storage,
        bill_attention, bill_country_id, bill_address_1, bill_address_2, bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax, customer_of,
        customer_type // may be updated
    } = req.body;

    const files = req.files || [];
    const conn = await db.promise().getConnection();

    try {
        console.log('[UPDATE] PUT /api/customers/:id initiated for customerId:', customerId);
        await conn.beginTransaction();

        console.log('[UPDATE] body keys:', Object.keys(req.body));
        console.log('[UPDATE] shipping_addresses raw:', req.body.shipping_addresses);

        // Safely parse arrays of IDs from the form
        const business_types_ids = mustArray(req.body.business_types);
        const product_interests_ids = mustArray(req.body.product_interests);
        const notification_prefs = mustArray(req.body.notification_prefs)[0] || {};

        let safeCustomerOf = (Array.isArray(req.body.customer_of) ? req.body.customer_of.join(',') : String(req.body.customer_of || ''))
            .split(',').map(s => s.trim()).filter(Boolean).join(',');

        // If customer_of is not provided, check if there's only one company
        if (!safeCustomerOf) {
            const [companies] = await conn.query('SELECT id FROM company_settings');
            if (companies.length === 1) {
                safeCustomerOf = String(companies[0].id);
            }
        }

        const tagsRaw = req.body.tags;
        const safeTags = typeof tagsRaw === 'string' ? tagsRaw : JSON.stringify(tagsRaw || []);

        // --- History Logging: Fetch old state before update ---
        const [oldVendorRows] = await conn.query(`
            SELECT 
                v.*, vo.*,
                tt.name as tax_treatment_name,
                ss.source as source_supply_name,
                c.name as currency_name,
                pt.terms as payment_terms_name
            FROM vendor v 
            LEFT JOIN vendor_other vo ON v.id = vo.vendor_id
            LEFT JOIN tax_treatment tt ON tt.id = vo.tax_treatment_id
            LEFT JOIN source_supply ss ON ss.id = vo.source_supply_id
            LEFT JOIN currency c ON c.id = vo.currency_id
            LEFT JOIN payment_terms pt ON pt.id = vo.payment_terms_id
            WHERE v.id = ?`, [customerId]);
        const oldVendor = oldVendorRows[0] || {};

        const generateDiff = async (oldObj, newObj, fieldsToCompare) => {
            const diff = [];
            for (const key of fieldsToCompare) {
                const oldValueId = oldObj[key] ?? '';
                const newValueId = newObj[key] ?? '';

                if (String(oldValueId) !== String(newValueId)) {
                    let from = oldValueId;
                    let to = newValueId;

                    if (key.endsWith('_id')) {
                        const nameKey = key.replace(/_id$/, '_name');
                        from = oldObj[nameKey] || oldValueId;
                        const lookupTable = { tax_treatment_id: 'tax_treatment', source_supply_id: 'source_supply', currency_id: 'currency', payment_terms_id: 'payment_terms' }[key];
                        const lookupField = { tax_treatment_id: 'name', source_supply_id: 'source', currency_id: 'name', payment_terms_id: 'terms' }[key];
                        if (lookupTable && newValueId) {
                            const [toRows] = await conn.query(`SELECT ${lookupField} as name FROM ${lookupTable} WHERE id = ?`, [newValueId]);
                            to = toRows[0]?.name || newValueId;
                        }
                    }
                    diff.push({ field: key, from: from, to: to });
                }
            }
            return diff;
        };

        const fieldsToTrack = [
            'company_name', 'display_name', 'email_address', 'phone_work', 'phone_mobile', 'website', 'remarks',
            'tax_treatment_id', 'tax_registration_number', 'source_supply_id', 'currency_id', 'payment_terms_id'
        ];
        const changes = await generateDiff(oldVendor, req.body, fieldsToTrack);
        if (changes.length > 0) {
            await conn.query(
                `INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, ?, ?)`,
                [customerId, userId, 'UPDATED', JSON.stringify(changes)]
            );
        }

        await conn.query(
            `UPDATE vendor
       SET company_name = ?, display_name = ?, email_address = ?, phone_work = ?, phone_mobile = ?, tags = ?, remarks = ?, website = ?, updated_user = ?, customer_type = ?, customer_of = ?
       WHERE id = ? AND company_type_id = ?`,
            [company_name, display_name, email_address, phone_work, phone_mobile, safeTags, remarks, website, userId, asIntCustomerType(customer_type), safeCustomerOf, customerId, COMPANY_TYPE_CUSTOMER,]
        );

        await conn.query(
            `INSERT INTO vendor_other (vendor_id, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id, business_type_other, outlets_count, avg_weekly_purchase, has_cold_storage)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                tax_treatment_id = VALUES(tax_treatment_id),
                tax_registration_number = VALUES(tax_registration_number),
                source_supply_id = VALUES(source_supply_id),
                currency_id = VALUES(currency_id),
                payment_terms_id = VALUES(payment_terms_id),
                business_type_other = VALUES(business_type_other),
                outlets_count = VALUES(outlets_count),
                avg_weekly_purchase = VALUES(avg_weekly_purchase),
                has_cold_storage = VALUES(has_cold_storage)`,
            [customerId, tax_treatment_id, tax_registration_number, source_supply_id, currency_id, payment_terms_id, business_type_other, outlets_count, avg_weekly_purchase, has_cold_storage]
        );

        // Use UPDATE instead of DELETE/INSERT to avoid accidentally deleting other address types.
        await conn.query(
            `UPDATE vendor_address SET
                bill_attention = ?, bill_country_id = ?, bill_address_1 = ?, bill_address_2 = ?,
                bill_city = ?, bill_state_id = ?, bill_zip_code = ?, bill_phone = ?, bill_fax = ?
             WHERE vendor_id = ?`,
            [
                bill_attention, bill_country_id, bill_address_1, bill_address_2,
                bill_city, bill_state_id, bill_zip_code, bill_phone, bill_fax, customerId
            ]
        );

        // --- Smartly update shipping addresses ---
        const rawShippingAddresses = mustArray(req.body.shipping_addresses);
        const incomingIds = rawShippingAddresses.map(addr => addr.id).filter(Boolean);

        // 1. Get existing address IDs from the database for this customer
        const [existingAddrs] = await conn.query(
            `SELECT id FROM vendor_shipping_addresses WHERE vendor_id = ?`,
            [customerId]
        );
        const existingIds = existingAddrs.map(a => a.id);

        // 2. Determine which addresses to delete (present in DB but not in incoming payload)
        const idsToDelete = existingIds.filter(id => !incomingIds.includes(id));
        if (idsToDelete.length > 0) {
            await conn.query(
                `DELETE FROM vendor_shipping_addresses WHERE id IN (?) AND vendor_id = ?`,
                [idsToDelete, customerId]
            );
            console.log(`[UPDATE] Deleted shipping addresses with IDs: ${idsToDelete.join(', ')} for customerId: ${customerId}`);
        }

        // 3. Insert or Update addresses
        for (const rawAddr of rawShippingAddresses) {
            const addr = normalizeShipAddr(rawAddr);
            if (rawAddr.id && existingIds.includes(rawAddr.id)) { // This is an existing address, so UPDATE it
                // --- PRESERVE DELIVERY DETAILS ---
                // Fetch the existing address to preserve fields not sent by the standard edit form.
                const [[existing]] = await conn.query(`SELECT * FROM vendor_shipping_addresses WHERE id = ?`, [rawAddr.id]);

                // Merge new data over existing data.
                const finalAddr = {
                    ...normalizeShipAddr(existing), // Start with existing, normalized data
                    ...addr,                        // Overwrite with incoming changes
                };

                await conn.query(
                    `UPDATE vendor_shipping_addresses SET 
                        ship_attention=?, ship_address_1=?, ship_address_2=?, ship_city=?, ship_state_id=?, ship_zip_code=?, ship_country_id=?, ship_phone=?, ship_fax=?, is_primary=?,
                        latitude=?, longitude=?, place_name=?, formatted_address=?, place_id=?, available_time_ids=?, delivery_window=?
                     WHERE id=? AND vendor_id=?`,
                    [
                        finalAddr.ship_attention, finalAddr.ship_address_1, finalAddr.ship_address_2, finalAddr.ship_city, finalAddr.ship_state_id, finalAddr.ship_zip_code, finalAddr.ship_country_id, finalAddr.ship_phone, finalAddr.ship_fax, finalAddr.is_primary,
                        finalAddr.latitude, finalAddr.longitude, finalAddr.place_name, finalAddr.formatted_address, finalAddr.place_id, finalAddr.available_time_ids, finalAddr.delivery_window,
                        rawAddr.id, customerId
                    ]
                );
                console.log(`[UPDATE] Updated shipping address ID ${rawAddr.id} for customerId ${customerId}`);
            } else { // This is a new address, so INSERT it
                await conn.query(
                    `INSERT INTO vendor_shipping_addresses
                     (vendor_id, ship_attention, ship_address_1, ship_address_2, ship_city, ship_state_id, ship_zip_code, ship_country_id, ship_phone, ship_fax, is_primary,
                      latitude, longitude, place_name, formatted_address, place_id, available_time_ids, delivery_window)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`,
                    [
                        customerId,
                        addr.ship_attention, addr.ship_address_1, addr.ship_address_2, addr.ship_city, addr.ship_state_id, addr.ship_zip_code, addr.ship_country_id, addr.ship_phone, addr.ship_fax, addr.is_primary,
                        addr.latitude, addr.longitude, addr.place_name, addr.formatted_address, addr.place_id, addr.available_time_ids,
                        addr.delivery_window || null,
                    ]
                );
                console.log(`[UPDATE] Inserted new shipping address for customerId ${customerId}: ${addr.ship_attention || 'N/A'}`);
            }
        }


        // Update linking tables: delete old and insert new
        await conn.query('DELETE FROM customer_business_types WHERE customer_id = ?', [customerId]);
        if (Array.isArray(business_types_ids) && business_types_ids.length > 0) {
            const businessTypeValues = business_types_ids.map(id => [customerId, id]);
            await conn.query('INSERT INTO customer_business_types (customer_id, business_type_id) VALUES ?', [businessTypeValues]);
        }

        await conn.query('DELETE FROM customer_product_interests WHERE customer_id = ?', [customerId]);
        if (Array.isArray(product_interests_ids) && product_interests_ids.length > 0) {
            const productInterestValues = product_interests_ids.map(id => [customerId, id]);
            await conn.query('INSERT INTO customer_product_interests (customer_id, product_interest_id) VALUES ?', [productInterestValues]);
        }

        // Update notification preferences: delete old and insert new
        await conn.query('DELETE FROM customer_notification_settings WHERE customer_id = ?', [customerId]);
        const notificationValues = [];
        for (const type in notification_prefs) {
            for (const channel in notification_prefs[type]) {
                const value = notification_prefs[type][channel];
                if (value) { // Only insert if there's a value
                    notificationValues.push([customerId, type, channel, value]);
                }
            }
        }
        if (notificationValues.length > 0) {
            await conn.query('INSERT INTO customer_notification_settings (customer_id, notification_type, channel, value) VALUES ?', [notificationValues]);
        }

        const fullAddress = [bill_address_1, bill_address_2, bill_city, bill_zip_code].filter(Boolean).join(', ');

        await conn.query(`DELETE FROM contact WHERE vendor_id = ?`, [customerId]);
        for (const p of contactPersons) {
            await conn.query(
                `INSERT INTO contact
           (vendor_id, is_primary, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department, customer_name, address, company_type_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    customerId,
                    p.is_primary ? 1 : 0,
                    p.salutation_id, p.first_name, p.last_name,
                    p.email, p.phone, p.mobile,
                    p.skype_name_number, p.designation, p.department,
                    display_name,
                    fullAddress,
                    COMPANY_TYPE_CUSTOMER
                ]
            );
        }

        for (const id of deletedAttachmentIds) {
            await conn.query(`DELETE FROM vendor_attachment WHERE id = ?`, [id]);
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const expiry = req.body[`attachment_expiry_${i}`] || null;
            const docTypeId = req.body[`attachment_doctype_${i}`] || null;
            await conn.query(
                `INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, expiry_date, document_type_id)
         VALUES (?, ?, ?, ?, ?)`,
                [customerId, f.path, f.originalname, expiry, docTypeId]
            );
        }

        for (let i = 0; ; i++) {
            const attId = req.body[`existing_attachment_id_${i}`];
            if (!attId) break;
            const expiry = req.body[`attachment_expiry_existing_${i}`] || null;
            const docTypeId = req.body[`attachment_doctype_existing_${i}`] || null;
            await conn.query(
                `UPDATE vendor_attachment SET expiry_date = ?, document_type_id = ? WHERE id = ?`,
                [expiry, docTypeId, attId]);
        }

        await conn.commit();
        return res.json({ ok: true, customerId, shipping_inserted: rawShippingAddresses.length });
    } catch (err) {
        await conn.rollback();
        console.error('[UPDATE][ERROR]', err);
        return res.status(400).json({ ok: false, error: String(err) });
    } finally {
        conn.release();
    }
});

/* ================================
   DELETE /api/customers/attachments/:id
================================ */
router.delete('/attachments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.promise().query(`DELETE FROM vendor_attachment WHERE id = ?`, [id]);
        res.json({ success: true, message: 'Attachment deleted' });
    } catch (err) {
        console.error('delete attachment:', err);
        res.status(500).json(errPayload('Failed to delete attachment', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers/attachment/:id/update
================================ */
router.post('/attachment/:id/update', uploadCustomer.single('file'), async (req, res) => {
    const { id } = req.params;
    const { expiry_date, document_type_id } = req.body;
    const file = req.file;

    const updates = [];
    const values = [];

    if (file) {
        updates.push('attachment_name = ?', 'attachment_path = ?');
        values.push(file.originalname, `uploads/customer/${file.filename}`);
    }
    updates.push('expiry_date = ?');
    updates.push('document_type_id = ?');
    values.push(expiry_date || null);
    values.push(document_type_id || null);
    values.push(id);

    try {
        await db.promise().query(`UPDATE vendor_attachment SET ${updates.join(', ')} WHERE id = ?`, values);
        res.json({ success: true, message: 'Attachment updated successfully' });
    } catch (err) {
        console.error('update attachment:', err);
        res.status(500).json(errPayload('Failed to update attachment', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers/:id/update-address
================================ */
router.post('/:id/update-address', async (req, res) => {
    const customerId = req.params.id;
    const payload = req.body;
    const conn = await db.promise().getConnection();

    try {
        await conn.beginTransaction();

        if (payload.billing) { // Check if the 'billing' object exists in the payload
            const billingData = payload.billing;
            await db.promise().query(
                `UPDATE vendor_address SET
           bill_attention = ?, bill_country_id = ?, bill_address_1 = ?, bill_address_2 = ?, bill_city = ?, bill_state_id = ?, bill_zip_code = ?, bill_phone = ?, bill_fax = ?
         WHERE vendor_id = ?`,
                [
                    billingData.attention, billingData.country, billingData.address, billingData.street2,
                    billingData.city, billingData.state, billingData.zip, billingData.phone, billingData.fax,
                    customerId
                ]
            );
        } else if (payload.shipping) { // Check if the 'shipping' object exists
            const shippingData = payload.shipping;
            const addr = normalizeShipAddr(shippingData); // Normalize the nested object

            if (shippingData.id) { // Check for ID on the nested object
                await conn.query(
                    `UPDATE vendor_shipping_addresses SET 
                        ship_attention=?, ship_address_1=?, ship_address_2=?, ship_city=?, ship_state_id=?, ship_zip_code=?, ship_country_id=?, ship_phone=?, ship_fax=?,
                        latitude=?, longitude=?, place_name=?, formatted_address=?, place_id=?, available_time_ids=?, delivery_window=?
                     WHERE id=? AND vendor_id=?`,
                    [
                        addr.ship_attention || null,
                        addr.ship_address_1 || null,
                        addr.ship_address_2 || null,
                        addr.ship_city || null,
                        addr.ship_state_id,
                        addr.ship_zip_code || null,
                        addr.ship_country_id,
                        addr.ship_phone || null,
                        addr.ship_fax || null,
                        addr.latitude || null,
                        addr.longitude || null,
                        addr.place_name || null,
                        addr.formatted_address || null,
                        addr.place_id || null,
                        addr.available_time_ids || null,
                        addr.delivery_window || null,
                        shippingData.id, // Use the ID from the shipping payload
                        customerId,
                    ]
                );
            } else {
                await conn.query(
                    `INSERT INTO vendor_shipping_addresses
                     (vendor_id, ship_attention, ship_address_1, ship_address_2, ship_city, ship_state_id, ship_zip_code, ship_country_id, ship_phone, ship_fax, is_primary,
                      latitude, longitude, place_name, formatted_address, place_id, available_time_ids, delivery_window)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`,
                    [
                        customerId, // This is the vendor ID from the URL parameter
                        addr.ship_attention || null,
                        addr.ship_address_1 || null,
                        addr.ship_address_2 || null,
                        addr.ship_city || null,
                        addr.ship_state_id,
                        addr.ship_zip_code || null,
                        addr.ship_country_id,
                        addr.ship_phone || null,
                        addr.ship_fax || null,
                        addr.is_primary,
                        addr.latitude || null,
                        addr.longitude || null,
                        addr.place_name || null,
                        addr.formatted_address || null,
                        addr.place_id || null,
                        addr.available_time_ids || null,
                        addr.delivery_window || null,
                    ]
                );
            }
        }
        await conn.commit();
        res.json({ success: true });
    } catch (err) {
        console.error('update-address:', err);
        res.status(500).json(errPayload('Failed to update address', 'DB_ERROR', err.message));
    } finally {
        if (conn) conn.release();
    }
});

/* ================================
   Contacts add/update (unchanged)
================================ */
router.post('/contacts', async (req, res) => {
    const {
        customer_id, salutation, first_name, last_name,
        email, phone, mobile, skype_name_number,
        designation, department
    } = req.body;

    try {
        await db.promise().query(
            `INSERT INTO contact
         (vendor_id, salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [customer_id, salutation, first_name, last_name, email, phone, mobile, skype_name_number, designation, department]
        );
        res.status(200).json({ message: 'Contact added' });
    } catch (err) {
        console.error('add customer contact:', err);
        res.status(500).json(errPayload('Failed to add contact', 'DB_ERROR', err.message));
    }
});

router.put('/contacts/:id', async (req, res) => {
    const {
        salutation_id, first_name, last_name, email,
        phone, mobile, skype_name_number, designation, department
    } = req.body;
    const id = req.params.id;

    try {
        await db.promise().query(
            `UPDATE contact SET
         salutation_id = ?, first_name = ?, last_name = ?, email = ?,
         phone = ?, mobile = ?, skype_name_number = ?, designation = ?, department = ?
       WHERE id = ?`,
            [salutation_id, first_name, last_name, email, phone, mobile, skype_name_number, designation, department, id]
        );
        res.json({ message: 'Contact updated' });
    } catch (err) {
        console.error('update customer contact:', err);
        res.status(500).json(errPayload('Failed to update contact', 'DB_ERROR', err.message));
    }
});

/* ================================
   GET /api/customers/:id/credit-application
================================ */
router.get('/:id/credit-application', async (req, res) => {
    const { id: customerId } = req.params;
    try {
        const [rows] = await db.promise().query(
            'SELECT * FROM customer_credit_applications WHERE customer_id = ?',
            [customerId]
        );
        if (rows.length === 0) {
            return res.status(404).json(errPayload('Credit application not found for this customer.', 'NOT_FOUND'));
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('get credit-application:', err);
        res.status(500).json(errPayload('Failed to load credit application', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers/:id/credit-application
================================ */
router.post('/:id/credit-application', async (req, res) => {
    const { id: customerId } = req.params;
    const {
        business_name, legal_entity_type, license_issuing_authority, trade_license_no,
        license_expiry_date, vat_registration_no, business_address, city, emirates,
        phone_no, fax_no, email, website
    } = req.body;

    // If legal_entity_type is an array from checkboxes, join it into a string.
    const legalEntityTypeDb = Array.isArray(legal_entity_type) ? legal_entity_type.join(',') : legal_entity_type;

    try {
        const fields = {
            customer_id: customerId,
            business_name,
            legal_entity_type: legalEntityTypeDb,
            license_issuing_authority,
            trade_license_no,
            license_expiry_date: license_expiry_date || null,
            vat_registration_no,
            business_address,
            city,
            emirates,
            phone_no,
            fax_no,
            email,
            website
        };

        await db.promise().query(
            'INSERT INTO customer_credit_applications SET ? ON DUPLICATE KEY UPDATE ?',
            [fields, fields]
        );

        res.json({ success: true, message: 'Credit application saved successfully.' });
    } catch (err) {
        console.error('save credit-application:', err);
        res.status(500).json(errPayload('Failed to save credit application', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers/:id/credit-limit/draft
   (Save a draft without submitting for approval)
================================ */
router.post('/:id/credit-limit/draft', uploadCustomer.array('attachments'), async (req, res) => {
    const { id: customerId } = req.params;
    const userId = req.session?.user?.id;
    const { credit_limit, credit_terms, remarks, reason } = req.body;
    const files = req.files || [];
    const deletedAttachmentIds = mustArray(req.body.deletedAttachmentIds);

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Check for an existing draft
        const [[existingDraft]] = await conn.query(
            `SELECT id FROM customer_credit_limit_requests WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
            [customerId]
        );

        let requestId;
        if (existingDraft) {
            requestId = existingDraft.id;
            await conn.query(
                `UPDATE customer_credit_limit_requests SET status_id = 3, credit_limit = ?, credit_terms = ?, remarks = ?, reason = ?, requested_by = ?, requested_at = NOW() WHERE id = ?`,
                [credit_limit, credit_terms, remarks, reason, userId, requestId]
            );
        } else {
            // Insert new draft
            const [ins] = await conn.query(
                `INSERT INTO customer_credit_limit_requests (customer_id, requested_by, credit_limit, credit_terms, remarks, reason, status_id, requested_at) VALUES (?, ?, ?, ?, ?, ?, 3, NOW())`,
                [customerId, userId, credit_limit, credit_terms, remarks, reason]
            );
            requestId = ins.insertId;
        }

        // Delete marked attachments
        if (deletedAttachmentIds.length > 0) {
            await conn.query(`DELETE FROM vendor_attachment WHERE id IN (?) AND credit_request_id = ?`, [deletedAttachmentIds, requestId]);
        }

        // Insert attachments for the draft
        if (files.length > 0) {
            const attachmentValues = files.map(f => [
                customerId, // vendor_id
                (f.path || '').replace(/\\/g, '/'),
                f.originalname,
                'CREDIT_LIMIT', // category
                requestId // credit_request_id
            ]);
            await conn.query(
                'INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, category, credit_request_id) VALUES ?',
                [attachmentValues]
            );
        }

        await conn.commit();
        res.json({ success: true, message: 'Draft saved successfully.' });
    } catch (err) {
        await conn.rollback();
        console.error('save credit-limit draft:', err);
        res.status(500).json(errPayload('Failed to save draft', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   GET /api/customers/credit-limit-requests/:requestId/attachments
================================ */
router.get('/credit-limit-requests/:requestId/attachments', async (req, res) => {
    const { requestId } = req.params;
    try {
        const [attachments] = await db.promise().query(
            `SELECT id, attachment_name, attachment_path FROM vendor_attachment WHERE category = 'CREDIT_LIMIT' AND credit_request_id = ?`,
            [requestId]
        );
        res.json(attachments || []);
    } catch (err) {
        console.error('get credit-limit attachments:', err);
        res.status(500).json(errPayload('Failed to load attachments', 'DB_ERROR', err.message));
    }
});

/* ================================
   DELETE /api/customers/credit-limit-requests/:requestId
================================ */
router.delete('/credit-limit-requests/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const userId = req.session?.user?.id;

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[request]] = await conn.query(`SELECT * FROM customer_credit_limit_requests WHERE id = ? AND status_id = 3`, [requestId]); // Only drafts can be deleted
        if (!request) {
            await conn.rollback();
            return res.status(404).json(errPayload('Draft request not found or cannot be deleted.', 'NOT_FOUND'));
        }

        // Delete the request itself
        await conn.query(`DELETE FROM customer_credit_limit_requests WHERE id = ?`, [requestId]);

        // Log history
        await conn.query(`INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, 'CREDIT_LIMIT_DRAFT_DELETED', ?)`, [request.customer_id, userId, JSON.stringify({ requestId })]);

        await conn.commit();
        res.json({ success: true, message: 'Credit limit draft has been deleted.' });
    } catch (err) {
        await conn.rollback();
        console.error('delete credit-limit request:', err);
        res.status(500).json(errPayload('Failed to delete draft', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* ================================
   POST /api/customers/:id/credit-limit
================================ */
router.post('/:id/credit-limit', uploadCustomer.array('attachments'), async (req, res) => {
    const { id: customerId } = req.params;
    const userId = req.session?.user?.id;
    const { credit_limit, credit_terms, remarks, reason } = req.body;
    const files = req.files || [];
    const deletedAttachmentIds = mustArray(req.body.deletedAttachmentIds);

    if (!credit_limit || !credit_terms) {
        return res.status(400).json(errPayload('Credit Limit and Credit Terms are required.', 'VALIDATION_ERROR'));
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Check for an existing draft to submit
        const [[existingDraft]] = await conn.query(
            `SELECT id FROM customer_credit_limit_requests WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
            [customerId]
        );

        let requestId;
        if (existingDraft) {
            // Update the draft to pending
            requestId = existingDraft.id;
            await conn.query(
                `UPDATE customer_credit_limit_requests SET status_id = 8, credit_limit = ?, credit_terms = ?, remarks = ?, reason = ?, requested_by = ?, requested_at = NOW() WHERE id = ?`,
                [credit_limit, credit_terms, remarks, reason, userId, requestId] // This line is correct, no change needed here.
            );
        } else {
            // Insert a new pending request directly
            const [ins] = await conn.query(
                `INSERT INTO customer_credit_limit_requests (customer_id, requested_by, credit_limit, credit_terms, remarks, reason, status_id, requested_at) VALUES (?, ?, ?, ?, ?, ?, 8, NOW())`,
                [customerId, userId, credit_limit, credit_terms, remarks, reason]
            );
            requestId = ins.insertId;
        }

        // Delete marked attachments
        if (deletedAttachmentIds.length > 0) {
            await conn.query(`DELETE FROM vendor_attachment WHERE id IN (?) AND credit_request_id = ?`, [deletedAttachmentIds, requestId]);
        }

        // Insert attachments
        if (files.length > 0) {
            const attachmentValues = files.map(f => [
                customerId, // vendor_id
                (f.path || '').replace(/\\/g, '/'),
                f.originalname,
                'CREDIT_LIMIT', // category
                requestId // credit_request_id
            ]);
            await conn.query(
                'INSERT INTO vendor_attachment (vendor_id, attachment_path, attachment_name, category, credit_request_id) VALUES ?',
                [attachmentValues]
            );
        }

        // Log history on the customer
        await conn.query(
            `INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, ?, ?)`,
            [customerId, userId, 'CREDIT_LIMIT_REQUESTED', JSON.stringify({ limit: credit_limit, terms: credit_terms })]
        );

        await conn.commit();
        res.json({ success: true, message: 'Credit limit request submitted for approval.' });

    } catch (err) {
        await conn.rollback();
        console.error('save credit-limit request:', err);
        // Clean up uploaded files on error
        for (const f of files) {
            try {
                if (f.path) fs.unlinkSync(f.path);
            } catch (e) {
                console.error('Failed to clean up file:', f.path, e);
            }
        }
        res.status(500).json(errPayload('Failed to save credit limit request', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});

/* =================================================================
   APPROVALS - These routes could be moved to a separate approvals.js file
================================================================= */

/* ================================
   GET /api/customers/credit-limit-requests
   (Fetches all pending requests for the approval list page)
   Updated to support pagination, search, and status filtering.
================================ */
router.get('/credit-limit-requests', async (req, res) => {
    const page = parseInt(req.query.page || 1, 10);
    const perPage = parseInt(req.query.per_page || 10, 10);
    const offset = (page - 1) * perPage;
    const search = req.query.search || '';
    const statusId = req.query.status_id || '8'; // Default to 'Pending'

    const whereClauses = [`r.status_id = ?`];
    const params = [statusId];

    if (search) {
        whereClauses.push(`(v.display_name LIKE ? OR r.credit_terms LIKE ?)`);
        params.push(like(search), like(search));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    try {
        const countQuery = `SELECT COUNT(*) as totalRows FROM customer_credit_limit_requests r JOIN vendor v ON r.customer_id = v.id ${whereSql}`;
        const [countResult] = await db.promise().query(countQuery, params);
        const totalRows = countResult[0].totalRows;

        const dataQuery = `
            SELECT
                r.id, r.customer_id, v.display_name AS customer_name, v.uniqid as customer_uniqid,
                r.credit_limit, r.credit_terms, r.remarks, r.reason, r.requested_at,
                u.name AS requested_by_name,
                s.name as status_name, s.bg_colour, s.colour,
                (SELECT CONCAT('[', GROUP_CONCAT(JSON_OBJECT('id', va.id, 'file_name', va.attachment_name, 'file_path', va.attachment_path)), ']')
                 FROM vendor_attachment va WHERE va.credit_request_id = r.id AND va.category = 'CREDIT_LIMIT') AS attachments
            FROM customer_credit_limit_requests r
            JOIN vendor v ON r.customer_id = v.id
            LEFT JOIN user u ON r.requested_by = u.id
            LEFT JOIN status s ON r.status_id = s.id
            ${whereSql}
            ORDER BY r.requested_at DESC
            LIMIT ? OFFSET ?
        `;

        const [requests] = await db.promise().query(dataQuery, [...params, perPage, offset]);

        res.json({
            data: requests || [],
            totalRows: totalRows
        });
    } catch (err) {
        console.error('get pending credit-limit-requests:', err);
        res.status(500).json(errPayload('Failed to load pending requests', 'DB_ERROR', err.message));
    }
});

/* ================================
   POST /api/customers/credit-limit-requests/:requestId/decide
   (Approve or Reject a request)
================================ */
router.post('/credit-limit-requests/:requestId/decide', async (req, res) => {
    const { requestId } = req.params;
    const { decision, comment } = req.body; // decision: 'approve' or 'reject'
    const approverId = req.session?.user?.id;

    if (!approverId) return res.status(401).json(errPayload('Authentication required.', 'AUTH_ERROR'));
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json(errPayload('Invalid decision.', 'VALIDATION_ERROR'));
    if (decision === 'reject' && !comment) return res.status(400).json(errPayload('A comment is required for rejection.', 'VALIDATION_ERROR'));

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [[request]] = await conn.query(`SELECT * FROM customer_credit_limit_requests WHERE id = ? AND status_id = 8`, [requestId]);
        if (!request) {
            await conn.rollback();
            return res.status(404).json(errPayload('Request not found or already processed.', 'NOT_FOUND'));
        }

        const [[customer]] = await conn.query(`SELECT credit_limit, credit_terms FROM vendor WHERE id = ?`, [request.customer_id]);

        if (decision === 'approve') {
            // 1. Update the request status
            await conn.query(`UPDATE customer_credit_limit_requests SET status_id = 1, approved_by = ?, approved_at = NOW() WHERE id = ?`, [approverId, requestId]); // This line is correct, no change needed here.

            // 2. Update the customer's main record
            await conn.query(`UPDATE vendor SET credit_limit = ?, credit_terms = ? WHERE id = ?`, [request.credit_limit, request.credit_terms, request.customer_id]);

            // 3. Log the approval and the change in history
            const historyDetails = { from: { limit: customer.credit_limit, terms: customer.credit_terms }, to: { limit: request.credit_limit, terms: request.credit_terms }, comment: comment || 'Approved' };
            await conn.query(`INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, 'CREDIT_LIMIT_APPROVED', ?)`, [request.customer_id, approverId, JSON.stringify(historyDetails)]);
        } else { // 'reject'
            await conn.query(`UPDATE customer_credit_limit_requests SET status_id = 2, approved_by = ?, approved_at = NOW(), rejection_reason = ? WHERE id = ?`, [approverId, comment, requestId]); // This line is correct, no change needed here.
            await conn.query(`INSERT INTO vendor_history (vendor_id, user_id, action, details) VALUES (?, ?, 'CREDIT_LIMIT_REJECTED', ?)`, [request.customer_id, approverId, JSON.stringify({ reason: comment })]);
        }

        await conn.commit();
        res.json({ success: true, message: `Request has been ${decision}d.` });
    } catch (err) {
        await conn.rollback();
        console.error('decide credit-limit-request:', err);
        res.status(500).json(errPayload('Failed to process request', 'DB_ERROR', err.message));
    } finally {
        conn.release();
    }
});


/* ================================
   GET /api/customers/:id/latest-credit-request
================================ */
router.get('/:id/latest-credit-request', async (req, res) => {
    const { id: customerId } = req.params;
    try {
        const [[request]] = await db.promise().query(
            `SELECT * FROM customer_credit_limit_requests WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
            [customerId]
        );
        res.json(request || null);
    } catch (err) {
        res.status(500).json(errPayload('Failed to load latest credit request', 'DB_ERROR', err.message));
    }
});

/* ================================
   GET /api/customers/:id/invoice-payments
   Get customer invoices that have payments allocated to them (from customer receivables)
================================ */
router.get('/:id/invoice-payments', async (req, res, next) => {
    try {
        const customerId = parseInt(req.params.id, 10);
        if (!customerId || !Number.isFinite(customerId)) {
            return res.status(400).json(errPayload('Invalid customer ID'));
        }

        const perPage = parseInt(req.query.per_page || 5, 10);
        const page = parseInt(req.query.page || 1, 10);
        const offset = (page - 1) * perPage;

        // Get total count first
        const [countResult] = await db.promise().query(`
            SELECT COUNT(DISTINCT ai.id) as total
            FROM ar_invoices ai
            INNER JOIN tbl_payment_allocation pa ON pa.reference_id = ai.id AND pa.alloc_type = 'invoice'
            INNER JOIN tbl_payment p ON p.id = pa.payment_id
            WHERE ai.customer_id = ?
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
        `, [customerId]);
        const totalRows = countResult[0].total;

        // Get invoices that have payment allocations
        const [invoicePayments] = await db.promise().query(`
            SELECT DISTINCT
                ai.id,
                ai.invoice_uniqid,
                ai.invoice_number,
                ai.invoice_date,
                ai.total,
                ai.currency_id,
                c.name as currency_code,
                s.name as status_name,
                SUM(CASE 
                    WHEN p.currency_id = ai.currency_id THEN pa.amount_bank
                    ELSE pa.amount_base
                END) as total_paid,
                COUNT(DISTINCT p.id) as payment_count
            FROM ar_invoices ai
            INNER JOIN tbl_payment_allocation pa ON pa.reference_id = ai.id AND pa.alloc_type = 'invoice'
            INNER JOIN tbl_payment p ON p.id = pa.payment_id
            LEFT JOIN currency c ON c.id = ai.currency_id
            LEFT JOIN status s ON s.id = ai.status_id
            WHERE ai.customer_id = ?
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
            GROUP BY ai.id, ai.invoice_uniqid, ai.invoice_number, ai.invoice_date, ai.total, ai.currency_id, c.name, s.name
            ORDER BY ai.invoice_date DESC, ai.id DESC
            LIMIT ? OFFSET ?
        `, [customerId, perPage, offset]);

        res.json({ data: invoicePayments || [], pagination: { total: totalRows, page, perPage } });
    } catch (e) {
        console.error('Error fetching invoice payments:', e);
        next(e);
    }
});

/* ================================
   GET /api/customers/:id/proforma-receives
   Get customer receivables that have proforma invoices allocated to them
================================ */
router.get('/:id/proforma-receives', async (req, res, next) => {
    try {
        const customerId = parseInt(req.params.id, 10);
        if (!customerId || !Number.isFinite(customerId)) {
            return res.status(400).json(errPayload('Invalid customer ID'));
        }

        const perPage = parseInt(req.query.per_page || 5, 10);
        const page = parseInt(req.query.page || 1, 10);
        const offset = (page - 1) * perPage;

        // Get total count first
        const [countResult] = await db.promise().query(`
            SELECT COUNT(DISTINCT p.id) as total
            FROM tbl_payment p
            INNER JOIN tbl_payment_allocation pa ON pa.payment_id = p.id AND pa.alloc_type = 'advance'
            INNER JOIN proforma_invoice pi ON pi.id = pa.reference_id
            WHERE p.party_id = ?
              AND p.is_customer_payment = 1
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
        `, [customerId]);
        const totalRows = countResult[0].total;

        // Get customer receivables that have proforma invoice allocations (advance payments)
        const [proformaReceives] = await db.promise().query(`
            SELECT DISTINCT
                p.id,
                p.payment_uniqid,
                p.payment_number,
                p.transaction_date,
                p.currency_id,
                c.name as currency_code,
                s.name as status_name,
                pt.name as payment_type_name,
                SUM(CASE 
                    WHEN p.currency_id = pi.currency_sale THEN pa.amount_bank
                    ELSE pa.amount_base
                END) as total_allocated,
                COUNT(DISTINCT pi.id) as proforma_count,
                GROUP_CONCAT(DISTINCT pi.proforma_invoice_no ORDER BY pi.proforma_invoice_no SEPARATOR ', ') as proforma_numbers
            FROM tbl_payment p
            INNER JOIN tbl_payment_allocation pa ON pa.payment_id = p.id AND pa.alloc_type = 'advance'
            INNER JOIN proforma_invoice pi ON pi.id = pa.reference_id
            LEFT JOIN currency c ON c.id = p.currency_id
            LEFT JOIN status s ON s.id = p.status_id
            LEFT JOIN payment_type pt ON pt.id = p.payment_type_id
            WHERE p.party_id = ?
              AND p.is_customer_payment = 1
              AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
            GROUP BY p.id, p.payment_uniqid, p.payment_number, p.transaction_date, p.currency_id, c.name, s.name, pt.name
            ORDER BY p.transaction_date DESC, p.id DESC
            LIMIT ? OFFSET ?
        `, [customerId, perPage, offset]);

        res.json({ data: proformaReceives || [], pagination: { total: totalRows, page, perPage } });
    } catch (e) {
        console.error('Error fetching proforma receives:', e);
        next(e);
    }
});

export default router;
