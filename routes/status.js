// routes/status.js
import express from "express";
import db from "../db.js"; // keep your existing path

const router = express.Router();

/**
 * NOTE:
 * - If your db.js uses `import mysql from 'mysql2'` + createConnection/createPool,
 *   you MUST call db.promise().query(...) to use async/await.
 * - If your db.js uses `import mysql from 'mysql2/promise'`,
 *   then you can call db.query(...) directly with await.
 * This route handles both safely by always using db.promise() if available.
 */

function getPromiseDb() {
    // If it's already a promise pool/conn (mysql2/promise), it has no .promise()
    // but .query returns a Promise. Detect that:
    const looksPromise = typeof db.query === "function" && db.query.length <= 2; // no callback arity
    if (looksPromise) return db;
    // Otherwise, wrap callback-style db into promise API:
    if (typeof db.promise === "function") return db.promise();
    // Final fallback: throw a clear error
    throw new Error("DB instance does not support promises. Fix db.js to use mysql2 or mysql2/promise.");
}

// GET /api/purchaseorder/templatesettings  (you can change the mount path)
router.get("/", async (_req, res) => {
    try {
        const pdb = getPromiseDb();
        const [rows] = await pdb.query(`
            SELECT id, name, bg_colour, colour
            FROM status
            ORDER BY id ASC
        `);
        res.json(rows || []);
    } catch (err) {
        console.error("GET /status failed:", err);
        res.status(500).json({
            error: true,
            message: err?.message || "Failed to fetch status settings"
        });
    }
});

export default router;
