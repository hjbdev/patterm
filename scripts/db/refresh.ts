import { assertDestructiveAllowed, withDatabase } from './databasePath';

withDatabase((database, appDataPath) => {
  assertDestructiveAllowed(appDataPath);
  const result = database.migrator().refresh();
  console.log(`Rolled back ${result.rolledBack.length} migration(s).`);
  console.log(`Migrated ${result.migrated.length} migration(s).`);
});
