import express from 'express';
import db from '../db.js';

const router = express.Router();

/**
 * GET /api/payment_terms
 * Fetches all payment terms.
 */
router.get('/', async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT id, terms FROM payment_terms ORDER BY terms ASC`
        );
        res.json(rows || []);
    } catch (err) {
        console.error('Failed to fetch payment terms:', err);
        res.status(500).json({
            error: { message: 'Failed to fetch payment terms' }
        });
    }
});

export default router;
