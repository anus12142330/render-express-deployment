// server/routes/lookups.js
import { Router } from "express";
import db from "../db.js";

const router = Router();

// GET /api/ports  -> [{id, name}]
router.get("/", async (req, res) => {
    try {
        const [rows] = await db.promise().execute(
            "SELECT id, name FROM mode_of_shipment ORDER BY name ASC"
        );
        res.json(rows);
    } catch (err) {
        console.error("GET /api/modelShipment error:", err);
        res.status(500).json({ error: "Failed to load ports" });
    }
});

export default router;
