import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DB_PATH: './data/test_copy_bot.db',
    },
  },
});
