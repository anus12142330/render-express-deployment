import db from "./db.js";

async function check() {
    try {
        const [views] = await db.promise().query("SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = 'portal_db'");
        console.log("VIEWS:", views.map(v => v.TABLE_NAME));

        const [procs] = await db.promise().query("SHOW PROCEDURE STATUS WHERE Db = 'portal_db'");
        console.log("PROCEDURES:", procs.map(p => p.Name));

        // Also search in routines
        const [routines] = await db.promise().query("SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = 'portal_db' AND ROUTINE_DEFINITION LIKE '%sales_order_approvals%'");
        console.log("BAD ROUTINES:", routines.map(r => r.ROUTINE_NAME));

    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

check();
