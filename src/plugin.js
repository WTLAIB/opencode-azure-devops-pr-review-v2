import { setupAzurePrReview } from './runtime.mjs';

// Pure OpenCode V2 definition; the host supplies its domain APIs.
export default {
  id: 'azpr',
  setup: context => setupAzurePrReview(context),
};
