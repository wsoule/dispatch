import type { LinearGrants } from './grants.js';
import { createLinearGateway } from './linear/linear-gateway.js';
import { createShowcaseWorkspace } from './linear/showcase.js';
import type { WorkspaceSource } from './routes.js';
import { toDispatch } from './toDispatch.js';

// The workspaces the hosted planner can open: the public demo, and each
// Linear workspace someone has granted read access to.

/** The public demo workspace: Better Tracker's showcase, dated to today. */
export function demoWorkspace(now: () => number = Date.now): WorkspaceSource {
  return {
    name: 'Northwind (demo)',
    viewerFor: () => ({ linearUserId: null }),
    load: () => {
      const iso = new Date(now()).toISOString();
      return Promise.resolve(
        toDispatch(createShowcaseWorkspace(iso.slice(0, 10)), iso)
      );
    },
  };
}

/** A granted Linear workspace: its members only, each read with their own grant. */
export function linearWorkspace(
  grants: LinearGrants,
  org: { orgId: string; name: string },
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): WorkspaceSource {
  return {
    name: org.name,
    viewerFor: (userId) =>
      userId === null ? null : grants.member(userId, org.orgId),
    load: async (userId) => {
      const accessToken = await grants.accessToken(userId ?? '', org.orgId);
      const data = await createLinearGateway({
        accessToken,
        fetch: fetchImpl,
      }).fetchWorkspace();
      return toDispatch(data, new Date(now()).toISOString());
    },
  };
}
