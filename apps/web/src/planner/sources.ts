import type {
  HostedWorkspaces,
  InstalledWorkspace,
} from '../hosting/workspaces.js';
import { GrantGone } from './grants.js';
import type { LinearGrants } from './grants.js';
import { LinearApiError } from './linear/gateway.js';
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
    shared: true,
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
      try {
        const data = await createLinearGateway({
          accessToken,
          fetch: fetchImpl,
        }).fetchWorkspace();
        return toDispatch(data, new Date(now()).toISOString());
      } catch (err) {
        // Revoked in Linear before it expired: forget it, ask them to reopen.
        if (err instanceof LinearApiError && err.kind === 'unauthorized') {
          grants.revoke(userId ?? '', org.orgId);
          throw new GrantGone('Linear no longer accepts this grant');
        }
        throw err;
      }
    },
  };
}

/** An installed workspace: its own dispatchd answers, as each member. */
export function hostedWorkspace(
  hosted: HostedWorkspaces,
  grants: LinearGrants,
  org: InstalledWorkspace
): WorkspaceSource {
  return {
    name: org.name,
    viewerFor: (userId) =>
      userId === null || !hosted.admits(userId, org.orgId)
        ? null
        : grants.member(userId, org.orgId),
    load: () => Promise.reject(new Error('served by its daemon')),
    daemon: (userId, pathAndQuery, req) =>
      hosted.request(userId, org.orgId, pathAndQuery, req),
  };
}
