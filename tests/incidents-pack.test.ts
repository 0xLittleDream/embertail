import { describe, expect, it } from 'vitest';
import { INCIDENT_PACK, expandCases, scenarios } from '../packages/runner/src/index.js';

describe('incidents pack', () => {
  it('is the core pack plus the 2025-26 incident-pattern scenarios', async () => {
    const catalog = await scenarios();
    const core = expandCases(catalog, 'core', '1000000', 'seed').map((c) => c.id);
    const incidents = expandCases(catalog, 'incidents', '1000000', 'seed').map((c) => c.id);
    expect(INCIDENT_PACK).toEqual(['S16', 'S56', 'S57', 'S65']);
    for (const id of [...new Set(core)]) expect(incidents).toContain(id);
    for (const id of INCIDENT_PACK) expect(incidents).toContain(id);
    expect(new Set(incidents).size).toBe(new Set(core).size + INCIDENT_PACK.length);
  });

  it('only names scenarios that exist and are open to outside agents', async () => {
    const byId = new Map((await scenarios()).map((s) => [s.id, s]));
    for (const id of INCIDENT_PACK) {
      expect(byId.has(id)).toBe(true);
      expect(byId.get(id)!.externalAgents).not.toBe(false);
    }
  });
});
