import { Router } from 'express';
import db from '../db.js';
import crypto from 'crypto';
import dayjs from 'dayjs';

const logHistory = async (conn, { module, moduleId, userId, action, details }) => {
  try {
    // If we don't have a userId (e.g., unauthenticated action), skip logging instead of throwing
    if (!module || !moduleId || !action) return;
    if (!userId) return;

    await conn.query(
      'INSERT INTO history (module, module_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [module, moduleId, userId, action, JSON.stringify(details || {})]
    );
  } catch (error) {
    console.error('Failed to log history:', error);
  }
};

const router = Router();

/**
 * @description   Get all harvest calendar entries with filtering and pagination
 * @route         GET /api/master/harvest-calendar
 * @access        Private (assumed)
 */
router.get('/', async (req, res, next) => {
    try {
        const { limit = 25, offset = 0, search, category_id, country_id } = req.query;

        let query = `
            SELECT 
                hc.id,
                hc.uniq_id,
                hc.product_name,
                hc.variety_name,
                hc.start_week,
                hc.end_week,
                hc.harvest_field,
                hc.start_month,
                hc.end_month,
                hc.category_id,
                hc.country_id,
                cat.name as category_name,
                c.name as country_name
            FROM 
                harvest_calendar hc
            LEFT JOIN 
                categories cat ON hc.category_id = cat.id
            LEFT JOIN 
                country c ON hc.country_id = c.id
        `;

        const whereClauses = [];
        const params = [];

        if (search) {
            whereClauses.push(`(hc.product_name LIKE ? OR hc.variety_name LIKE ? OR c.name LIKE ? OR hc.start_week LIKE ? OR hc.end_week LIKE ?)`);
            params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (category_id) {
            whereClauses.push(`hc.category_id = ?`);
            params.push(category_id);
        }
        if (country_id) {
            whereClauses.push(`hc.country_id = ?`);
            params.push(country_id);
        }

        if (whereClauses.length > 0) {
            query += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        // Get total count for pagination
        // The JOIN is necessary for searching by country name (c.name)
        const countQuery = `
            SELECT COUNT(*) as total 
            FROM harvest_calendar hc 
            LEFT JOIN 
                categories cat ON hc.category_id = cat.id
            LEFT JOIN 
                country c ON hc.country_id = c.id
            ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        `;
        const [totalRows] = await db.promise().query(countQuery, params);
        const total = totalRows[0].total;

        // Add ordering and pagination to the main query
        query += ` ORDER BY hc.product_name ASC, hc.variety_name ASC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));

        const [data] = await db.promise().query(query, params);

        res.json({
            success: true,
            message: 'Harvest calendar entries fetched successfully.',
            data,
            total
        });
    } catch (error) {
        console.error('Error fetching harvest calendar entries:', error);
        next(error);
    }
});

/**
 * @description   Get a single harvest calendar entry by ID, with history
 * @route         GET /api/master/harvest-calendar/:id
 * @access        Private (assumed)
 */
router.get('/:identifier', async (req, res, next) => {
    try {
        const { identifier } = req.params;

        // Determine if identifier is numeric ID or string uniq_id
        const isNumericId = /^\d+$/.test(identifier);
        const whereField = isNumericId ? 'hc.id' : 'hc.uniq_id';
        
        const mainQuery = `
            SELECT 
                hc.*,
                cat.name as category_name,
                c.name as country_name
            FROM 
                harvest_calendar hc
            LEFT JOIN 
                categories cat ON hc.category_id = cat.id
            LEFT JOIN 
                country c ON hc.country_id = c.id
            WHERE ${whereField} = ?
        `;
        const [mainRows] = await db.promise().query(mainQuery, [identifier]);

        if (mainRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Harvest entry not found.' });
        }

        const harvestEntry = mainRows[0];

        const historyQuery = `
            SELECT h.*, u.name as user_name FROM history h
            LEFT JOIN user u ON u.id = h.user_id
            WHERE h.module = 'harvest_calendar' AND h.module_id = ? 
            ORDER BY created_at DESC
        `;
        const [historyRows] = await db.promise().query(historyQuery, [harvestEntry.id]);

        res.json({ ...harvestEntry, history: historyRows });
    } catch (error) {
        next(error);
    }
});

/**
 * @description   Create a new harvest calendar entry
 * @route         POST /api/master/harvest-calendar
 * @access        Private (assumed)
 */
router.post('/', async (req, res, next) => {
    try {
        const {
            category_id,
            product_name,
            variety_name,
            country_id,
            start_week,
            end_week,
            harvest_field = 'week',
            start_month = null,
            end_month = null
        } = req.body;

        if (!product_name || !country_id || !start_week || !end_week) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields.' });
        }

        const uniq_id = `hvc_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

        const query = `
            INSERT INTO harvest_calendar 
                (uniq_id, category_id, product_name, variety_name, country_id, start_week, end_week, harvest_field, start_month, end_month) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const params = [
            uniq_id,
            category_id || null,
            product_name,
            variety_name || null,
            country_id,
            start_week,
            end_week,
            harvest_field,
            start_month || null,
            end_month || null
        ];

        const [result] = await db.promise().query(query, params);

        await logHistory(db.promise(), {
            module: 'harvest_calendar',
            moduleId: result.insertId,
            userId: req.session?.user?.id || null,
            action: 'CREATED',
            details: req.body
            });

        res.status(201).json({
            success: true,
            message: 'Harvest entry created successfully.',
            data: { id: result.insertId, uniq_id, ...req.body }
        });
    } catch (error) {
        console.error('Error creating harvest entry:', error);
        next(error);
    }
});

/**
 * @description   Update an existing harvest calendar entry
 * @route         PUT /api/master/harvest-calendar/:id
 * @access        Private (assumed)
 */
router.put('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            category_id,
            product_name,
            variety_name,
            country_id,
            start_week,
            end_week,
            harvest_field = 'week',
            start_month = null,
            end_month = null
        } = req.body;

        if (!product_name || !country_id || !start_week || !end_week) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields.' });
        }

        // 1. Fetch the current state before updating
        const [currentRows] = await db.promise().query(`
            SELECT 
                hc.*,
                cat.name as category_name,
                c.name as country_name
            FROM harvest_calendar hc
            LEFT JOIN categories cat ON hc.category_id = cat.id
            LEFT JOIN country c ON hc.country_id = c.id
            WHERE hc.id = ?
        `, [id]);

        if (currentRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Harvest entry not found.' });
        }
        const oldData = currentRows[0];

        const query = `
            UPDATE harvest_calendar SET
                category_id = ?,
                product_name = ?,
                variety_name = ?,
                country_id = ?,
                start_week = ?,
                end_week = ?,
                harvest_field = ?,
                start_month = ?,
                end_month = ?
            WHERE id = ?
        `;
        
        const params = [
            category_id || null,
            product_name,
            variety_name || null,
            country_id,
            start_week,
            end_week,
            harvest_field,
            start_month || null,
            end_month || null,
            id
        ];

        const [result] = await db.promise().query(query, params);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Harvest entry not found.' });
        }

        // 2. Fetch names for new IDs to make history log readable
        const [newCategory] = req.body.category_id ? await db.promise().query('SELECT name FROM categories WHERE id = ?', [req.body.category_id]) : [[]];
        const [newCountry] = req.body.country_id ? await db.promise().query('SELECT name FROM country WHERE id = ?', [req.body.country_id]) : [[]];

        const newData = {
            ...req.body,
            category_name: newCategory[0]?.name,
            country_name: newCountry[0]?.name
        };

        // 3. Compare and build changes for history
        const changes = [];
        const compareFields = {
            'product_name': 'Product Name',
            'variety_name': 'Variety',
            'category_name': 'Category',
            'country_name': 'Country',
            'start_week': 'Start Week',
            'end_week': 'End Week',
            'harvest_field': 'Harvest Field',
            'start_month': 'Start Month',
            'end_month': 'End Month'
        };

        for (const key in compareFields) {
            const oldValue = key.endsWith('_week') ? `Week ${oldData[key]}` : oldData[key];
            const newValue = key.endsWith('_week') ? `Week ${newData[key]}` : newData[key];

            if (String(oldValue || '') !== String(newValue || '')) {
                changes.push({ field: compareFields[key], from: oldValue || 'empty', to: newValue || 'empty' });
            }
        }

        if (changes.length > 0) {
            await logHistory(db.promise(), {
                module: 'harvest_calendar',
                moduleId: id,
                userId: req.session?.user?.id || null,
                action: 'UPDATED',
                details: changes
            });
        }

        res.json({
            success: true,
            message: 'Harvest entry updated successfully.'
        });
    } catch (error) {
        console.error('Error updating harvest entry:', error);
        next(error);
    }
});

/**
 * @description   Delete a harvest calendar entry
 * @route         DELETE /api/harvest-calendar/:id
 * @access        Private (assumed)
 */
router.delete('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;

        // Fetch the entry to log its details before deleting
        const [rows] = await db.promise().query('SELECT product_name, uniq_id FROM harvest_calendar WHERE id = ?', [id]);

        const [result] = await db.promise().query('DELETE FROM harvest_calendar WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Harvest entry not found.' });
        }

        const deletedInfo = rows.length > 0 ? { deleted: `${rows[0].product_name} (#${rows[0].uniq_id})` } : { deleted_id: id };
        await logHistory(db.promise(), {
            module: 'harvest_calendar',
            moduleId: id,
            userId: req.session?.user?.id || null,
            action: 'DELETED',
            details: deletedInfo
            });


        res.json({
            success: true,
            message: 'Harvest entry deleted successfully.'
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/harvest-calendar/graph
// Query: products=Apple,Banana&countries=1,3,7&varieties=Royal Gala,Fuji
router.get('/graph', async (req, res) => {
  const conn = db.promise();
  try {
    const { products = '', countries = '', varieties = '' } = req.query;

    const prodArr = (products || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const countryArr = (countries || '')
      .split(',')
      .map(s => Number(s))
      .filter(Boolean);

    const varietyArr = (varieties || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // Base SQL
    let sql = `
      SELECT hc.id,
             hc.uniq_id,
             hc.category_id,
             hc.product_name,
             hc.variety_name,
             hc.country_id,
             c.name AS country_name,
             hc.start_week,
             hc.end_week
      FROM harvest_calendar hc
      LEFT JOIN countries c ON c.id = hc.country_id
      WHERE 1=1
    `;
    const params = [];

    if (prodArr.length) {
      sql += ` AND hc.product_name IN (${prodArr.map(() => '?').join(',')})`;
      params.push(...prodArr);
    }

    if (countryArr.length) {
      sql += ` AND hc.country_id IN (${countryArr.map(() => '?').join(',')})`;
      params.push(...countryArr);
    }

    if (varietyArr.length) {
      sql += ` AND hc.variety_name IN (${varietyArr.map(() => '?').join(',')})`;
      params.push(...varietyArr);
    }

    // Optional: ensure sane data
    sql += ` AND hc.start_week IS NOT NULL AND hc.end_week IS NOT NULL
             AND hc.start_week <= hc.end_week
             ORDER BY hc.variety_name IS NULL, hc.variety_name, hc.product_name, c.name`;

    const [rows] = await conn.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('graph endpoint error', err);
    res.status(500).json({ message: 'Failed to load graph data' });
  }
});


export default router;
