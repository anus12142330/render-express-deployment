import { runContainerTrackingJob } from './cron/container-tracking.js';

console.log('Executing container tracking job as a standalone script.');

runContainerTrackingJob()
    .then(() => {
        console.log('Job completed successfully.');
        process.exit(0); // Success
    })
    .catch(error => {
        console.error('Job failed:', error);
        process.exit(1); // Failure
    });
