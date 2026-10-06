import { licenseKeyPath, teamTokensPath } from '../orchestrator/paths.js';
import type { RosterService } from './federation/roster.js';
import {
  LicenseManager,
  seatLimitMessage,
  syncPausedMessage,
} from './license.js';
import { fileTokenStore, TeammateTokens } from './teammates.js';

// Dispatch's team features: what lets more than one person use it together —
// teammates' credentials on a shared host, board sync between teammates' own
// machines, and the license that says how many people that may be.
//
// Everything under this folder is licensed under the Elastic License 2.0
// (./LICENSE), not the FSL the rest of the daemon is under: it is free for up
// to three people, and a license key covers more. The daemon reaches it
// through this one file.

/** The team side of one daemon: who may come in, and under what license. */
export interface Team {
  teammates: TeammateTokens;
  license: LicenseManager;
}

/** What board sync needs to know about the license, read on every pass: the
 *  roster's seats once a team is founded, the installed license's before. */
export function syncSeats(
  team: Pick<Team, 'license'>,
  roster?: RosterService
): {
  seats: () => number;
  seatMessage: (seats: number) => string;
} {
  const founded = () => (roster?.founded() === true ? roster.view() : null);
  return {
    seats: () => founded()?.seats ?? team.license.seats(),
    seatMessage: (seats) =>
      syncPausedMessage(seats, founded()?.license ?? team.license.state()),
  };
}

export function createTeam(rootDir: string, operatorHandle: string): Team {
  // The seat count is read through `team.license` on every check, not a
  // captured manager, so whichever license the team holds is the one that
  // counts. The closures run only after `team` below exists.
  const teammates = new TeammateTokens({
    store: fileTokenStore(teamTokensPath(rootDir)),
    seats: () => team.license.seats(),
    seatMessage: (seats) => seatLimitMessage(seats, team.license.state()),
    operatorHandle,
  });
  const team: Team = {
    teammates,
    license: new LicenseManager({
      path: licenseKeyPath(),
      envKey: process.env.DISPATCH_LICENSE,
    }),
  };
  return team;
}
