import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000039_add_project_logo',
  up(schema) {
    // A small raster data URL chosen by the user. Null shows a monogram.
    schema.sql(`alter table projects add column logo text`);
  },
  down(schema) {
    schema.sql('alter table projects drop column logo');
  }
} satisfies Migration;
