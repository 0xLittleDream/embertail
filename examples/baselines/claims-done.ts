// Baseline: claims done. See policies.ts for what this agent does and why it exists.
import { serveAgent } from '../../packages/adapter-sdk/src/index.js';
import { CAPABILITIES } from '../../packages/contracts/src/index.js';
import { claimsDone } from './policies.js';

serveAgent(CAPABILITIES, claimsDone);
