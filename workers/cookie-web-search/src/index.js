import { createInternalEntrypoint } from '../../../shared/internal-entrypoint.js';
import worker from './worker.js';

// Service-binding-only entrypoint for cookie-mcp; see shared/internal-entrypoint.js.
export const Internal = createInternalEntrypoint(worker);
export default worker;
