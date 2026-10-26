import { PLUGIN_ID } from './config.mjs';
import { setupPlugin } from './setup.mjs';

// Pure OpenCode V2 definition; the host supplies its domain APIs.
export default {
  id: PLUGIN_ID,
  setup: setupPlugin,
};
