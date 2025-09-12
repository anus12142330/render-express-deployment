// server/routes/lookups.js
import { Router } from "express";
import db from "../db.js";

const router = Router();


// GET /api/incoterms -> [{code, label}]
router.get("/", async (req, res) => {
    try {
        const [rows] = await db.promise().execute(
            "SELECT id, brand_name FROM brands ORDER BY brand_name ASC"
        );
        res.json(rows);
    } catch (err) {
        console.error("GET /api/brandname error:", err);
        res.status(500).json({ error: "Failed to load brandname" });
    }
});

export default router;
