// src/database/db.ts
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '../../memory.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

export async function initializeDatabase() {
    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });

    // Enable WAL mode for better concurrency and crash recovery
    await db.exec('PRAGMA journal_mode = WAL;');
    // Enable foreign key constraints for cascade deletes
    await db.exec('PRAGMA foreign_keys = ON;');

    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    await db.exec(schema);
    console.log('Database initialized and schema applied.');

    // --- Start: Robust Schema Migration Checks ---

    // Check and add 'status' column to 'agents' table if it doesn't exist
    const agentsTableInfo = await db.all("PRAGMA table_info(agents);");
    if (!agentsTableInfo.some((column: any) => column.name === 'status')) {
        try {
            await db.exec("ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'ACTIVE'");
            console.log('Successfully added "status" column to "agents" table.');
        } catch (error: any) {
            console.error('Error adding "status" column to "agents" table:', error);
            throw error;
        }
    }

    // Check and add timestamp columns to 'plans' table if they don't exist
    const plansTableInfo = await db.all("PRAGMA table_info(plans);");
    if (!plansTableInfo.some((column: any) => column.name === 'last_updated_timestamp_unix')) {
        try {
            await db.exec("ALTER TABLE plans ADD COLUMN last_updated_timestamp_unix INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))");
            await db.exec("ALTER TABLE plans ADD COLUMN last_updated_timestamp_iso TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
            console.log('Successfully added timestamp columns to "plans" table.');
        } catch (error: any) {
            console.error('Error adding timestamp columns to "plans" table:', error);
            throw error;
        }
    }

    // Check and add timestamp and new detail columns to 'plan_tasks' table if they don't exist
    const planTasksTableInfo = await db.all("PRAGMA table_info(plan_tasks);");

    // Timestamp columns
    if (!planTasksTableInfo.some((column: any) => column.name === 'last_updated_timestamp_unix')) {
        try {
            await db.exec("ALTER TABLE plan_tasks ADD COLUMN last_updated_timestamp_unix INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))");
            await db.exec("ALTER TABLE plan_tasks ADD COLUMN last_updated_timestamp_iso TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
            console.log('Successfully added timestamp columns to "plan_tasks" table.');
        } catch (error: any) {
            console.error('Error adding timestamp columns to "plan_tasks" table:', error);
            throw error;
        }
    }

    // NEW: Migration for 'purpose' column
    if (!planTasksTableInfo.some((column: any) => column.name === 'purpose')) {
        try {
            await db.exec("ALTER TABLE plan_tasks ADD COLUMN purpose TEXT");
            console.log('Successfully added "purpose" column to "plan_tasks" table.');
        } catch (error: any) {
            console.error('Error adding "purpose" column to "plan_tasks" table:', error);
            throw error;
        }
    }

    // NEW: Migration for 'success_criteria_text' column
    if (!planTasksTableInfo.some((column: any) => column.name === 'success_criteria_text')) {
        try {
            await db.exec("ALTER TABLE plan_tasks ADD COLUMN success_criteria_text TEXT");
            console.log('Successfully added "success_criteria_text" column to "plan_tasks" table.');
        } catch (error: any) {
            console.error('Error adding "success_criteria_text" column to "plan_tasks" table:', error);
            throw error;
        }
    }

    // NEW: Migration for 'code_content' column
    if (!planTasksTableInfo.some((column: any) => column.name === 'code_content')) {
        try {
            await db.exec("ALTER TABLE plan_tasks ADD COLUMN code_content TEXT");
            console.log('Successfully added "code_content" column to "plan_tasks" table.');
        } catch (error: any) {
            console.error('Error adding "code_content" column to "plan_tasks" table:', error);
            throw error;
        }
    }

    // --- End: Robust Schema Migration Checks ---

    // Insert default agents if they don't exist to satisfy foreign key constraints
    await db.run(
        `INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?)`,
        'cline', 'Cline Agent', 'Primary AI coding agent', Math.floor(Date.now() / 1000), new Date().toISOString(), 'ACTIVE'
    );
    await db.run(
        `INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?)`,
        'BLACKBOXAI', 'Blackbox AI Agent', 'Default agent for AI operations', Math.floor(Date.now() / 1000), new Date().toISOString(), 'ACTIVE'
    );
    await db.run(
        `INSERT OR IGNORE INTO agents (agent_id, name, description, creation_timestamp_unix, creation_timestamp_iso, status) VALUES (?, ?, ?, ?, ?, ?)`,
        'test_agent', 'Test Agent', 'Agent for testing purposes', Math.floor(Date.now() / 1000), new Date().toISOString(), 'ACTIVE'
    );
    console.log('Default agents ensured in database.');

    return db;
}


export async function getDatabase() {
    return open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });
}
