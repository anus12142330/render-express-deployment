// server/routes/lookups.js
import { Router } from "express";
import db from "../db.js";

const router = Router();



// GET /api/uoms -> [{code, label}]
router.get("/", async (req, res) => {
    try {
        const [rows] = await db.promise().execute(
            "SELECT id, tax_name, rate, type, code, is_active FROM taxes WHERE is_active = 1 ORDER BY id ASC"
        );
        res.json(rows);
    } catch (err) {
        console.error("GET /api/taxes error:", err);
        res.status(500).json({ error: "Failed to load Taxes" });
    }
});

export default router;
