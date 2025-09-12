import express from "express";
import db from "../db.js";

const router = express.Router();
// GET /api/shipment-stages?include_inactive=0
router.get("/", async (req, res) => {
    try {
        const includeInactive = String(req.query.include_inactive ?? "0") === "1";
        const where = includeInactive ? "1=1" : "is_inactive = 0";
        const [rows] = await db.promise().query(
            `SELECT id, name, is_inactive, sort_order
       FROM shipment_stage
       WHERE ${where}
       ORDER BY sort_order ASC, id ASC`
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: { message: "Failed to load stages", hint: e.message } });
    }
});

export default router;
