// Baseline: blind payer. See policies.ts for what this agent does and why it exists.
import { serveAgent } from '../../packages/adapter-sdk/src/index.js';
import { CAPABILITIES } from '../../packages/contracts/src/index.js';
import { blindPayer } from './policies.js';

serveAgent(CAPABILITIES, blindPayer);
