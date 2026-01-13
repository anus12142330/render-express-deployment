// server/migrations/run_entity_enforcement_migration.js
// Script to run the entity enforcement migration
const { pool } = require('../src/db/tx.cjs');

async function runMigration() {
    const conn = await pool.getConnection();
    
    try {
        console.log('Starting entity enforcement migration...\n');
        
        // Step 1: Drop existing triggers if they exist (for idempotency)
        console.log('Step 1: Dropping existing triggers (if any)...');
        try {
            await conn.query('DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_insert');
            await conn.query('DROP TRIGGER IF EXISTS trg_gl_journal_lines_validate_entity_update');
            console.log('✅ Existing triggers dropped (if they existed)\n');
        } catch (error) {
            console.log('⚠️  Note: ' + error.message + '\n');
        }
        
        // Step 2: Create INSERT trigger
        console.log('Step 2: Creating INSERT trigger...');
        await conn.query(`
            CREATE TRIGGER trg_gl_journal_lines_validate_entity_insert
            BEFORE INSERT ON gl_journal_lines
            FOR EACH ROW
            BEGIN
                DECLARE acc_type INT;

                SELECT account_type_id INTO acc_type
                FROM acc_chart_accounts
                WHERE id = NEW.account_id
                LIMIT 1;

                -- If account is AR (1) or AP (6), entity_type and entity_id are required
                IF acc_type IN (1, 6) THEN
                    IF NEW.entity_type IS NULL OR NEW.entity_id IS NULL THEN
                        SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT = 'Entity is mandatory for AR/AP journal lines. entity_type and entity_id must be provided.';
                    END IF;

                    -- Validate entity_type value
                    IF NEW.entity_type NOT IN ('CUSTOMER', 'SUPPLIER') THEN
                        SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT = 'Invalid entity_type. Must be "CUSTOMER" for AR accounts or "SUPPLIER" for AP accounts.';
                    END IF;

                    -- Validate entity_type matches account type
                    IF acc_type = 1 AND NEW.entity_type != 'CUSTOMER' THEN
                        SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT = 'AR accounts (account_type_id=1) must have entity_type="CUSTOMER"';
                    END IF;

                    IF acc_type = 6 AND NEW.entity_type != 'SUPPLIER' THEN
                        SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT = 'AP accounts (account_type_id=6) must have entity_type="SUPPLIER"';
                    END IF;
                END IF;
            END
        `);
        console.log('✅ INSERT trigger created successfully\n');
        
        // Step 3: Create UPDATE trigger
        console.log('Step 3: Creating UPDATE trigger...');
        await conn.query(`
            CREATE TRIGGER trg_gl_journal_lines_validate_entity_update
            BEFORE UPDATE ON gl_journal_lines
            FOR EACH ROW
            BEGIN
                DECLARE acc_type INT;

                SELECT account_type_id INTO acc_type
                FROM acc_chart_accounts
                WHERE id = NEW.account_id
                LIMIT 1;

                -- If account is AR (1) or AP (6), entity_type and entity_id are required
                IF acc_type IN (1, 6) THEN
                    IF NEW.entity_type IS NULL OR NEW.entity_id IS NULL THEN
                        SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT = 'Entity is mandatory for AR/AP journal lines. entity_type and entity_id must be provided.';
                    END IF;

                    -- Validate entity_type value
                    IF NEW.entity_type NOT IN ('CUSTOMER', 'SUPPLIER') THEN
                        SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT = 'Invalid entity_type. Must be "CUSTOMER" for AR accounts or "SUPPLIER" for AP accounts.';
                    END IF;

                    -- Validate entity_type matches account type
                    IF acc_type = 1 AND NEW.entity_type != 'CUSTOMER' THEN
                        SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT = 'AR accounts (account_type_id=1) must have entity_type="CUSTOMER"';
                    END IF;

                    IF acc_type = 6 AND NEW.entity_type != 'SUPPLIER' THEN
                        SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT = 'AP accounts (account_type_id=6) must have entity_type="SUPPLIER"';
                    END IF;
                END IF;
            END
        `);
        console.log('✅ UPDATE trigger created successfully\n');
        
        console.log('✅ Migration completed successfully!');
        console.log('Entity enforcement is now active for AR/AP journal lines.');
        console.log('\nTriggers created:');
        console.log('  - trg_gl_journal_lines_validate_entity_insert');
        console.log('  - trg_gl_journal_lines_validate_entity_update');
        
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error(error);
        throw error;
    } finally {
        conn.release();
    }
}

// Run if called directly
if (require.main === module) {
    runMigration()
        .then(() => {
            console.log('\nMigration script finished.');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\nMigration script failed:', error);
            process.exit(1);
        });
}

module.exports = { runMigration };
