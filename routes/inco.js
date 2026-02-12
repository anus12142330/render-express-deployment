// server/routes/lookups.js
import { Router } from "express";
import db from "../db.js";

const router = Router();


// GET /api/incoterms -> [{id, name, trade_type_id}]
router.get("/", async (req, res) => {
    try {
        const [rows] = await db.promise().execute(
            "SELECT id, name AS label, trade_type_id FROM inco_terms ORDER BY name ASC"
        );
        res.json(rows);
    } catch (err) {
        console.error("GET /api/incoterms error:", err);
        res.status(500).json({ error: "Failed to load incoterms" });
    }
});

export default router;
