// server/routes/lookups.js
import { Router } from "express";
import db from "../db.js";

const router = Router();


// GET /api/incoterms -> [{code, label}]
router.get("/", async (req, res) => {
    try {
        // Accept 'search' or 'q' for consistency with other endpoints
        const searchTerm = req.query.search || req.query.q || '';
        const [rows] = await db.promise().execute(
            // `SELECT id, bank_name FROM acc_bank_details WHERE bank_name LIKE ? ORDER BY bank_name ASC`,
            `SELECT id, bank_name, nick_name FROM acc_bank_details WHERE bank_name LIKE ? OR nick_name LIKE ? ORDER BY bank_name ASC`,
            [`%${searchTerm}%`, `%${searchTerm}%`]
        );
        res.json(rows);
    } catch (err) {
        console.error("GET /api/bank details error:", err);
        res.status(500).json({ error: "Failed to load bank details", detail: err.message });
    }
});


router.get("/full", async (req, res) => {
    try {
        // Accept 'search' or 'q' for consistency with other endpoints
        const searchTerm = req.query.search || req.query.q || '';
        const [rows] = await db.promise().execute(
            // `SELECT id, bank_name FROM acc_bank_details WHERE bank_name LIKE ? ORDER BY bank_name ASC`,
            `SELECT id, bank_name, nick_name, acc_name AS account_name, acc_no AS account_number, iban_no AS iban, swift_code AS swift FROM acc_bank_details WHERE bank_name LIKE ? OR nick_name LIKE ? ORDER BY bank_name ASC`,
            [`%${searchTerm}%`, `%${searchTerm}%`]
        );
        res.json(rows);
    } catch (err) {
        console.error("GET /api/bank details error:", err);
        res.status(500).json({ error: "Failed to load bank details", detail: err.message });
    }
});


export default router;
