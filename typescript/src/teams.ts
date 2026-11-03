import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toTeam, type Team } from "./models.js";
import type { RegionOption } from "./regions.js";

/**
 * Org-scoped sub-groups of members, each with an optional default snapshot
 * new team machines boot from.
 *
 * Creating a team requires org admin/owner. Every other write requires
 * team-admin authority — inherited by every org admin/owner, or held
 * directly via a team-admin membership.
 *
 * A team is the same in every region. Its default snapshot is per region,
 * like snapshots: `region` on `list`, `get` and `setDefaultSnapshot` picks
 * which region's default is read or set.
 */
export class Teams {
  constructor(private readonly transport: Transport) {}

  /** Create a team in an org. Requires org admin/owner. `org` defaults to your home org. */
  async create(name: string, org = ""): Promise<Team> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.createTeam, {
      orgId: org,
      name,
    });
    return toTeam(resp);
  }

  /**
   * Teams in the org: every team for an org admin/owner, else just the
   * teams you're a direct member of. `org` defaults to your home org. Each
   * team's `defaultSnapshotId` is the region's the call goes to.
   */
  async list(org = "", opts: RegionOption = {}): Promise<Team[]> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.listTeams,
      { orgId: org },
      { region: opts.region },
    );
    return (resp.teams ?? []).map(toTeam);
  }

  /** A team's roster and its default snapshot in the region the call goes to. */
  async get(teamId: string, opts: RegionOption = {}): Promise<Team> {
    const resp = await this.transport.unary(
      BoxdApiDefinition.methods.getTeam,
      { teamId },
      { region: opts.region },
    );
    return toTeam(resp);
  }

  /** Rename a team. Requires team-admin. */
  async rename(teamId: string, name: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.renameTeam, { teamId, name });
  }

  /** Delete a team. Requires team-admin. Terminal. */
  async delete(teamId: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.destroyTeam, { teamId });
  }

  /** Add an existing org member to the team. Requires team-admin. */
  async addMember(teamId: string, userId: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.addTeamMember, { teamId, userId });
  }

  /** Remove a member from the team. Requires team-admin. */
  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.removeTeamMember, { teamId, userId });
  }

  /** Set a team member's role ("admin" or "member"). Requires team-admin. */
  async setMemberRole(teamId: string, userId: string, role: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setTeamMemberRole, {
      teamId,
      userId,
      role,
    });
  }

  /**
   * Set or clear (`null`) the team's default snapshot — new team machines
   * boot from it unless a size/snapshot is picked explicitly.
   *
   * Requires team-admin. Must be a snapshot you can access AND shared — a
   * private default would silently work only for you and be invisible to
   * every other team member.
   *
   * Each region has its own default, a snapshot of that region: `region`
   * picks it, and must be the snapshot's region.
   */
  async setDefaultSnapshot(
    teamId: string,
    snapshotId: string | null,
    opts: RegionOption = {},
  ): Promise<void> {
    await this.transport.unary(
      BoxdApiDefinition.methods.setTeamDefaultSnapshot,
      { teamId, snapshotId: snapshotId ?? "" },
      { region: opts.region },
    );
  }
}
