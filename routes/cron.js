import express from "express";
import { runContainerTrackingJob } from '../cron/container-tracking.js';

const router = express.Router();

// POST /api/cron/run-container-tracking
router.post("/run-container-tracking", async (req, res) => {
    // Optional: Add authentication/authorization check here to ensure only admins can run this.
    console.log("Manual trigger for container tracking job received.");

    // Run the job asynchronously and return a response immediately.
    runContainerTrackingJob();

    res.status(202).json({ message: "Container tracking job has been triggered. Check server logs for progress." });
});

export default router;
