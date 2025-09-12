import express from "express";
import db from "../db.js";

const router = express.Router();

// GET /api/purchaseorder/templatesettings
router.get("/", async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT id, name, content FROM terms_condition ORDER BY name ASC`
        );
        res.json(rows || []);
    } catch (err) {
        console.error(err);
        res.status(500).json(
            errPayload(err?.message || "Failed to fetch template settings")
        );
    }
});


export default router;
