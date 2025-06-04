import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import * as sqliteVec from 'sqlite-vec';

async function testLoadExtension() {
  const db = await open({
    filename: ':memory:',
    driver: sqlite3.Database,
  });

  try {
    // @ts-ignore
    if (typeof db.enableLoadExtension === 'function') {
      // @ts-ignore
      db.enableLoadExtension(true);
      console.log('Enabled SQLite extension loading.');
    }
    await sqliteVec.load(db);
    console.log('sqlite-vec extension loaded successfully.');
  } catch (error) {
    console.error('Failed to load sqlite-vec extension:', error);
  } finally {
    await db.close();
  }
}

testLoadExtension();
