"use client";

import { useState, type FormEvent } from "react";
import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/app/AuthContext";
import { Card, PageHeader, Badge, Button } from "@/components/ui";

export default function MembersPage() {
  return (
    <AuthGate>
      <Members />
    </AuthGate>
  );
}

type Role = "owner" | "admin" | "member" | "viewer";

function Members() {
  const { activeTenant } = useAuth();
  const isOwner = activeTenant?.role === "owner";
  const isAdminOrOwner = activeTenant?.role === "admin" || isOwner;

  const members = trpc.invitations.members.useQuery(undefined, { enabled: isAdminOrOwner });
  const invites = trpc.invitations.list.useQuery(undefined, { enabled: isAdminOrOwner });
  const utils = trpc.useUtils();
  const createInvite = trpc.invitations.create.useMutation({
    onSuccess: () => {
      utils.invitations.list.invalidate();
    },
  });
  const revokeInvite = trpc.invitations.revoke.useMutation({
    onSuccess: () => utils.invitations.list.invalidate(),
  });
  const setRole = trpc.invitations.setMemberRole.useMutation({
    onSuccess: () => utils.invitations.members.invalidate(),
  });
  const removeMember = trpc.invitations.removeMember.useMutation({
    onSuccess: () => utils.invitations.members.invalidate(),
  });

  const [email, setEmail] = useState("");
  const [role, setRoleInput] = useState<Exclude<Role, "owner">>("member");
  const [lastToken, setLastToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await createInvite.mutateAsync({ email, role });
      setLastToken(res.token);
      setEmail("");
    } catch (e) {
      setError((e as Error).message ?? "invite failed");
    }
  }

  const inviteUrl = (token: string) =>
    typeof window === "undefined" ? "" : `${window.location.origin}/accept-invite?token=${token}`;

  if (!isAdminOrOwner) {
    return (
      <>
        <PageHeader title="Members" subtitle="Workspace access control" />
        <Card>
          <p className="text-(--color-text-muted) text-sm">
            Only admins and owners can view members.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Members" subtitle="Workspace access control" />

      {/* Invite form */}
      <Card className="mb-4">
        <h2 className="font-semibold mb-3">Invite a new member</h2>
        <form onSubmit={onInvite} className="flex flex-col md:flex-row gap-3 md:items-end">
          <label className="flex-1 flex flex-col gap-1 text-sm">
            <span className="text-(--color-text-muted)">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-(--color-bg) border border-(--color-border) rounded px-3 py-2 outline-none focus:border-(--color-accent)"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-(--color-text-muted)">Role</span>
            <select
              value={role}
              onChange={(e) => setRoleInput(e.target.value as Exclude<Role, "owner">)}
              className="bg-(--color-bg) border border-(--color-border) rounded px-3 py-2 outline-none focus:border-(--color-accent)"
            >
              <option value="admin">admin</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </select>
          </label>
          <Button type="submit" disabled={createInvite.isPending}>
            {createInvite.isPending ? "Inviting…" : "Send invite"}
          </Button>
        </form>
        {error && <p className="text-sm text-(--color-danger) mt-2">{error}</p>}
        {lastToken && (
          <div className="mt-3 p-3 rounded border border-(--color-accent)/40 bg-(--color-accent)/5">
            <div className="text-xs text-(--color-text-muted) mb-1">Share this invite link:</div>
            <code className="text-xs break-all">{inviteUrl(lastToken)}</code>
          </div>
        )}
      </Card>

      {/* Active members */}
      <Card className="mb-4">
        <h2 className="font-semibold mb-3">Active members</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
              <th className="py-2 pr-3 font-medium">User</th>
              <th className="py-2 pr-3 font-medium">Role</th>
              <th className="py-2 pr-3 font-medium">Joined</th>
              {isOwner && <th className="py-2 pr-3 font-medium text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.data?.map((m) => (
              <tr key={m.membershipId} className="border-b border-(--color-border)/50">
                <td className="py-2 pr-3">
                  <div>{m.name || m.email}</div>
                  {m.name && <div className="text-(--color-text-muted) text-xs">{m.email}</div>}
                </td>
                <td className="py-2 pr-3">
                  {isOwner ? (
                    <select
                      value={m.role}
                      onChange={(e) =>
                        setRole.mutate({ membershipId: m.membershipId, role: e.target.value as Role })
                      }
                      className="bg-(--color-bg) border border-(--color-border) rounded px-2 py-1 text-sm"
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                      <option value="viewer">viewer</option>
                    </select>
                  ) : (
                    <Badge>{m.role}</Badge>
                  )}
                </td>
                <td className="py-2 pr-3 text-(--color-text-muted)">
                  {new Date(m.createdAt).toLocaleDateString()}
                </td>
                {isOwner && (
                  <td className="py-2 pr-3 text-right">
                    <button
                      onClick={() => {
                        if (confirm(`Remove ${m.email}?`)) {
                          removeMember.mutate({ membershipId: m.membershipId });
                        }
                      }}
                      className="text-(--color-danger) hover:underline text-xs"
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {!members.data?.length && (
              <tr>
                <td colSpan={isOwner ? 4 : 3} className="py-3 text-(--color-text-muted) text-center">
                  No members yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Pending invites */}
      <Card>
        <h2 className="font-semibold mb-3">Pending invitations</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-(--color-text-muted) border-b border-(--color-border)">
              <th className="py-2 pr-3 font-medium">Email</th>
              <th className="py-2 pr-3 font-medium">Role</th>
              <th className="py-2 pr-3 font-medium">Expires</th>
              <th className="py-2 pr-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invites.data?.map((i) => (
              <tr key={i.id} className="border-b border-(--color-border)/50">
                <td className="py-2 pr-3">{i.email}</td>
                <td className="py-2 pr-3">
                  <Badge>{i.role}</Badge>
                </td>
                <td className="py-2 pr-3 text-(--color-text-muted)">
                  {new Date(i.expiresAt).toLocaleDateString()}
                </td>
                <td className="py-2 pr-3 text-right">
                  <button
                    onClick={() => revokeInvite.mutate({ id: i.id })}
                    className="text-(--color-danger) hover:underline text-xs"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
            {!invites.data?.length && (
              <tr>
                <td colSpan={4} className="py-3 text-(--color-text-muted) text-center">
                  No pending invitations
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
