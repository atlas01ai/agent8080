// Database migration system for Alerts Service
// Uses better-sqlite3 for synchronous operations

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.DATABASE_PATH || './data/alerts.db';

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function getCurrentVersion(db) {
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get();
    return row?.version || 0;
  } catch (err) {
    // Table doesn't exist yet
    if (err.message.includes('no such table')) {
      return 0;
    }
    throw err;
  }
}

function applySchemaV1(db) {
  const schemaSQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSQL);
  
  // Record migration (idempotent)
  db.prepare('INSERT OR REPLACE INTO schema_version (version, description) VALUES (?, ?)')
    .run(1, 'Initial schema: subscribers, wallets, payments, alerts, positions, blocks');
  
  console.log('✅ Schema v1 applied');
}

function applySchemaV2(db) {
  console.log('Applying schema v2: Discord and performance improvements...');
  
  // Add discord_handle to subscribers
  try {
    db.prepare(`ALTER TABLE subscribers ADD COLUMN discord_handle TEXT`).run();
    console.log('  ✅ Added discord_handle to subscribers');
  } catch (err) {
    if (err.message.includes('duplicate column')) {
      console.log('  ℹ️  discord_handle already exists');
    } else {
      throw err;
    }
  }
  
  // Add index on whale_alerts for deduplication performance
  try {
    db.prepare(`CREATE INDEX idx_alerts_subscriber_tx ON whale_alerts(subscriber_id, tx_hash)`).run();
    console.log('  ✅ Created index on whale_alerts(subscriber_id, tx_hash)');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('  ℹ️  Index already exists');
    } else {
      throw err;
    }
  }
  
  // Record migration (idempotent)
  db.prepare('INSERT OR REPLACE INTO schema_version (version, description) VALUES (?, ?)')
    .run(2, 'Add discord_handle field and performance index');
  
  console.log('✅ Schema v2 applied');
}

function applySchemaV3(db) {
  console.log('Applying schema v3: Pending alerts queue for reliable Discord DM delivery...');
  
  // Create pending_alerts table if it doesn't exist
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='pending_alerts'`
  ).get();
  
  if (!tableExists) {
    db.prepare(`
      CREATE TABLE pending_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE CASCADE,
        alert_type TEXT NOT NULL,
        alert_data TEXT NOT NULL,
        priority INTEGER DEFAULT 5,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        next_attempt_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP,
        discord_message_id TEXT,
        error_log TEXT
      )
    `).run();
    console.log('  ✅ Created pending_alerts table');
  } else {
    console.log('  ℹ️  pending_alerts table already exists');
  }
  
  // Create indexes if they don't exist
  const indexes = [
    { name: 'idx_pending_alerts_subscriber', sql: 'CREATE INDEX idx_pending_alerts_subscriber ON pending_alerts(subscriber_id, delivered_at)' },
    { name: 'idx_pending_alerts_next_attempt', sql: 'CREATE INDEX idx_pending_alerts_next_attempt ON pending_alerts(next_attempt_at, attempts)' },
    { name: 'idx_pending_alerts_priority', sql: 'CREATE INDEX idx_pending_alerts_priority ON pending_alerts(priority, created_at)' }
  ];
  
  for (const idx of indexes) {
    const indexExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
    ).get(idx.name);
    
    if (!indexExists) {
      db.prepare(idx.sql).run();
      console.log(`  ✅ Created index ${idx.name}`);
    } else {
      console.log(`  ℹ️  Index ${idx.name} already exists`);
    }
  }
  
  // Record migration (idempotent)
  db.prepare('INSERT OR REPLACE INTO schema_version (version, description) VALUES (?, ?)')
    .run(3, 'Pending alerts queue for reliable Discord DM delivery');
  
  console.log('✅ Schema v3 applied');
}

function migrate() {
  const db = getDb();
  
  try {
    const currentVersion = getCurrentVersion(db);
    console.log(`Current schema version: ${currentVersion}`);
    
    if (currentVersion < 1) {
      console.log('Applying v1...');
      applySchemaV1(db);
    }
    
    if (currentVersion < 2) {
      console.log('Applying v2...');
      applySchemaV2(db);
    }
    
    if (currentVersion < 3) {
      console.log('Applying v3...');
      applySchemaV3(db);
    }
    
    if (currentVersion >= 3) {
      console.log('Database is up to date');
    }
    
    console.log('\nMigration complete');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

function createTestData() {
  const db = getDb();
  
  try {
    // Insert test subscriber
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO subscribers (discord_id, discord_handle, email, tier, whale_threshold_eth)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run('123456789', '@testuser', 'test@example.com', 'free', 10.0);
    
    if (result.changes > 0) {
      console.log('✅ Test subscriber created');
    } else {
      console.log('ℹ️  Test subscriber already exists');
    }
  } catch (error) {
    console.error('Failed to create test data:', error);
    throw error;
  } finally {
    db.close();
  }
}

function showStatus() {
  const db = getDb();
  try {
    const version = getCurrentVersion(db);
    console.log(`Current schema version: ${version}`);
    
    // Count records
    const tables = ['subscribers', 'subscriber_wallets', 'payments', 'whale_alerts', 'aave_positions', 'pending_alerts'];
    for (const table of tables) {
      try {
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
        console.log(`  ${table}: ${count} records`);
      } catch (e) {
        console.log(`  ${table}: table not found`);
      }
    }
  } finally {
    db.close();
  }
}

// CLI interface
const command = process.argv[2];

switch (command) {
  case 'up':
    migrate();
    break;
    
  case 'seed':
    migrate();
    createTestData();
    break;
    
  case 'status':
    showStatus();
    break;
    
  default:
    console.log('Usage: node migrate.js [up|seed|status]');
    console.log('  up     - Apply migrations');
    console.log('  seed   - Apply migrations + create test data');
    console.log('  status - Show current schema version and record counts');
    process.exit(0);
}
