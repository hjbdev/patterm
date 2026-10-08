import { assertDestructiveAllowed, withDatabase } from './databasePath';

withDatabase((database, appDataPath) => {
  assertDestructiveAllowed(appDataPath);
  const rolledBack = database.migrator().rollback();
  console.log(rolledBack.length === 0 ? 'Nothing to roll back.' : `Rolled back:\n${rolledBack.map((name) => `- ${name}`).join('\n')}`);
});
