import { withDatabase } from './databasePath';

withDatabase((database) => {
  for (const row of database.migrator().status()) {
    console.log(`${row.status.padEnd(7)} batch=${row.batch ?? '-'} ${row.migration}`);
  }
});
