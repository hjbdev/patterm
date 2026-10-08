import { backupBeforeMigrations } from '../../app/Services/DatabaseBackupService';
import { withDatabase } from './databasePath';

withDatabase((database, appDataPath) => {
  const backup = backupBeforeMigrations(appDataPath);
  if (backup) console.log(`Backed up app.db to ${backup.directory}`);
  const ran = database.migrator().migrate();
  console.log(ran.length === 0 ? 'Nothing to migrate.' : `Migrated:\n${ran.map((name) => `- ${name}`).join('\n')}`);
});
