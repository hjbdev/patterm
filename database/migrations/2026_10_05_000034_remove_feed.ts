import type { Migration } from '../../app/Database/Migration';
import addFeed from './2026_09_30_000024_add_feed';

export default {
  name: '2026_10_05_000034_remove_feed',
  up(schema) {
    // The feed experiment is gone; its posts and settings go with it.
    schema.sql('drop table feed_posts');
    schema.sql('drop table feed_threads');
    schema.sql(`delete from settings where key = 'feed.settings.v1'`);
  },
  down(schema) {
    addFeed.up(schema);
  }
} satisfies Migration;
