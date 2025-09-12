// server/routes/lookups.js
import { Router } from "express";
import db from "../db.js";

const router = Router();


// GET /api/incoterms -> [{code, label}]
router.get("/", async (req, res) => {
    try {
        const [rows] = await db.promise().execute(
            "SELECT id, name FROM manufacturers ORDER BY name ASC"
        );
        res.json(rows);
    } catch (err) {
        console.error("GET /api/manufacture error:", err);
        res.status(500).json({ error: "Failed to load manufacture" });
    }
});

export default router;
