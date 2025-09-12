// server/routes/lookups.js
import { Router } from "express";
import db from "../db.js";

const router = Router();


// GET /api/incoterms -> [{code, label}]
router.get("/", async (req, res) => {
    try {
        const [rows] = await db.promise().execute(
            "SELECT acc_bank_details.* AS label FROM acc_bank_details ORDER BY name ASC"
        );
        res.json(rows);
    } catch (err) {
        console.error("GET /api/bank details error:", err);
        res.status(500).json({ error: "Failed to load bank details" });
    }
});

export default router;
