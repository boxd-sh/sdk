"""`boxd.teams` — org-scoped sub-groups of members.

Creating a team requires org admin/owner. Every other write requires
team-admin authority — inherited by every org admin/owner, or held directly
via a team-admin membership.
"""

from __future__ import annotations

from .. import _mappers as m
from .._generated import api_pb2
from ..models import Team
from . import Namespace


class Teams(Namespace):
    """Create teams and manage their rosters and default snapshot."""

    def create(self, name: str, org: str = "") -> Team:
        """Create a team in an org. Requires org admin/owner."""
        return m.team(
            self._transport.call(
                "CreateTeam", api_pb2.CreateTeamRequest(org_id=org, name=name)
            )
        )

    def list(self, org: str = "") -> list[Team]:
        """Teams in the org: every team for an org admin/owner, else just
        the teams you're a direct member of."""
        resp = self._transport.call(
            "ListTeams", api_pb2.ListTeamsRequest(org_id=org)
        )
        return [m.team(t) for t in resp.teams]

    def get(self, team_id: str) -> Team:
        """A team's roster and default snapshot."""
        return m.team(
            self._transport.call("GetTeam", api_pb2.GetTeamRequest(team_id=team_id))
        )

    def rename(self, team_id: str, name: str) -> None:
        """Rename a team. Requires team-admin."""
        self._transport.call(
            "RenameTeam", api_pb2.RenameTeamRequest(team_id=team_id, name=name)
        )

    def delete(self, team_id: str) -> None:
        """Delete a team. Requires team-admin. Terminal."""
        self._transport.call(
            "DestroyTeam", api_pb2.DestroyTeamRequest(team_id=team_id)
        )

    def add_member(self, team_id: str, user_id: str) -> None:
        """Add an existing org member to the team. Requires team-admin."""
        self._transport.call(
            "AddTeamMember",
            api_pb2.AddTeamMemberRequest(team_id=team_id, user_id=user_id),
        )

    def remove_member(self, team_id: str, user_id: str) -> None:
        """Remove a member from the team. Requires team-admin."""
        self._transport.call(
            "RemoveTeamMember",
            api_pb2.RemoveTeamMemberRequest(team_id=team_id, user_id=user_id),
        )

    def set_member_role(self, team_id: str, user_id: str, role: str) -> None:
        """Set a team member's role ("admin" or "member"). Requires team-admin."""
        self._transport.call(
            "SetTeamMemberRole",
            api_pb2.SetTeamMemberRoleRequest(
                team_id=team_id, user_id=user_id, role=role
            ),
        )

    def set_default_snapshot(self, team_id: str, snapshot_id: str | None) -> None:
        """Set or clear (`None`) the team's default snapshot — new team
        machines boot from it unless a size/snapshot is picked explicitly.

        Requires team-admin. Must be a snapshot you can access AND shared —
        a private default would silently work only for you and be invisible
        to every other team member.
        """
        self._transport.call(
            "SetTeamDefaultSnapshot",
            api_pb2.SetTeamDefaultSnapshotRequest(
                team_id=team_id, snapshot_id=snapshot_id or ""
            ),
        )


class AsyncTeams(Namespace):
    """Async twin of :class:`Teams`."""

    async def create(self, name: str, org: str = "") -> Team:
        """Create a team in an org. Requires org admin/owner."""
        return m.team(
            await self._transport.call(
                "CreateTeam", api_pb2.CreateTeamRequest(org_id=org, name=name)
            )
        )

    async def list(self, org: str = "") -> list[Team]:
        """Teams in the org: every team for an org admin/owner, else just
        the teams you're a direct member of."""
        resp = await self._transport.call(
            "ListTeams", api_pb2.ListTeamsRequest(org_id=org)
        )
        return [m.team(t) for t in resp.teams]

    async def get(self, team_id: str) -> Team:
        """A team's roster and default snapshot."""
        return m.team(
            await self._transport.call(
                "GetTeam", api_pb2.GetTeamRequest(team_id=team_id)
            )
        )

    async def rename(self, team_id: str, name: str) -> None:
        """Rename a team. Requires team-admin."""
        await self._transport.call(
            "RenameTeam", api_pb2.RenameTeamRequest(team_id=team_id, name=name)
        )

    async def delete(self, team_id: str) -> None:
        """Delete a team. Requires team-admin. Terminal."""
        await self._transport.call(
            "DestroyTeam", api_pb2.DestroyTeamRequest(team_id=team_id)
        )

    async def add_member(self, team_id: str, user_id: str) -> None:
        """Add an existing org member to the team. Requires team-admin."""
        await self._transport.call(
            "AddTeamMember",
            api_pb2.AddTeamMemberRequest(team_id=team_id, user_id=user_id),
        )

    async def remove_member(self, team_id: str, user_id: str) -> None:
        """Remove a member from the team. Requires team-admin."""
        await self._transport.call(
            "RemoveTeamMember",
            api_pb2.RemoveTeamMemberRequest(team_id=team_id, user_id=user_id),
        )

    async def set_member_role(self, team_id: str, user_id: str, role: str) -> None:
        """Set a team member's role ("admin" or "member"). Requires team-admin."""
        await self._transport.call(
            "SetTeamMemberRole",
            api_pb2.SetTeamMemberRoleRequest(
                team_id=team_id, user_id=user_id, role=role
            ),
        )

    async def set_default_snapshot(
        self, team_id: str, snapshot_id: str | None
    ) -> None:
        """Set or clear (`None`) the team's default snapshot — new team
        machines boot from it unless a size/snapshot is picked explicitly.

        Requires team-admin. Must be a snapshot you can access AND shared —
        a private default would silently work only for you and be invisible
        to every other team member.
        """
        await self._transport.call(
            "SetTeamDefaultSnapshot",
            api_pb2.SetTeamDefaultSnapshotRequest(
                team_id=team_id, snapshot_id=snapshot_id or ""
            ),
        )
