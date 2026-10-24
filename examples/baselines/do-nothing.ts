// Baseline: do nothing. See policies.ts for what this agent does and why it exists.
import { serveAgent } from '../../packages/adapter-sdk/src/index.js';
import { CAPABILITIES } from '../../packages/contracts/src/index.js';
import { doNothing } from './policies.js';

serveAgent(CAPABILITIES, doNothing);
