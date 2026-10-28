import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toTeam, type Team } from "./models.js";

/**
 * Org-scoped sub-groups of members, each with an optional default snapshot
 * new team machines boot from.
 *
 * Creating a team requires org admin/owner. Every other write requires
 * team-admin authority — inherited by every org admin/owner, or held
 * directly via a team-admin membership.
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
   * teams you're a direct member of. `org` defaults to your home org.
   */
  async list(org = ""): Promise<Team[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listTeams, { orgId: org });
    return (resp.teams ?? []).map(toTeam);
  }

  /** A team's roster and default snapshot. */
  async get(teamId: string): Promise<Team> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getTeam, { teamId });
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
   */
  async setDefaultSnapshot(teamId: string, snapshotId: string | null): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.setTeamDefaultSnapshot, {
      teamId,
      snapshotId: snapshotId ?? "",
    });
  }
}
