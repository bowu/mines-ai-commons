import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useAgents } from "@/contexts/AgentsContext";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  ChevronUp,
  FlaskConical,
  Loader2,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, matchPath, useLocation, useNavigate } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";

const navItems = [{ path: "/skills", label: "Skills", icon: FlaskConical }];

type VmUiStatus = "ready" | "starting" | "idle" | "error";

function toVmUiStatus(
  vmStatus?: string | null,
  desiredVmState?: string | null,
): VmUiStatus {
  const wakePending = desiredVmState === "running" && vmStatus !== "running";
  switch (vmStatus) {
    case "running":
      return "ready";
    case "error":
      return "error";
    case "starting":
    case "creating":
    case "stopping":
    case "deleting":
    case "upgrading":
      return "starting";
    case "stopped":
      return wakePending ? "starting" : "idle";
    default:
      return wakePending ? "starting" : "idle";
  }
}

export function AppSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const {
    agents,
    busyAgentIds,
    sessions,
    createAgent,
    loadSessions,
    createNewSession,
    updateAgent,
    deleteAgent,
    renameSession,
    removeSession,
  } = useAgents();
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState("");
  const [renamingAgentId, setRenamingAgentId] = useState<string | null>(null);
  const [renameAgentValue, setRenameAgentValue] = useState("");
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [agentActionLoading, setAgentActionLoading] = useState(false);
  const renameSessionInputRef = useRef<HTMLInputElement>(null);
  const renameAgentInputRef = useRef<HTMLInputElement>(null);

  // Parse current URL to find selected agent and session
  const agentMatch = matchPath("/agents/:agentId/c/:sessionId", pathname);
  const agentOnlyMatch = matchPath("/agents/:agentId", pathname);
  const selectedAgentId =
    agentMatch?.params.agentId || agentOnlyMatch?.params.agentId || null;
  const selectedSessionId = agentMatch?.params.sessionId || null;

  // Auto-expand the selected agent
  useEffect(() => {
    if (selectedAgentId && !expandedAgents.has(selectedAgentId)) {
      setExpandedAgents((prev) => new Set([...prev, selectedAgentId]));
    }
  }, [selectedAgentId]);

  // Load sessions when an agent is expanded.
  // If the currently selected URL session is missing from local cache, force
  // a refresh so the sidebar always includes the active conversation.
  useEffect(() => {
    for (const agentId of expandedAgents) {
      const cached = sessions.get(agentId);
      if (!cached) {
        void loadSessions(agentId);
        continue;
      }
      if (
        selectedAgentId === agentId &&
        selectedSessionId &&
        !cached.some((session) => session.id === selectedSessionId)
      ) {
        void loadSessions(agentId, { force: true });
      }
    }
  }, [
    expandedAgents,
    sessions,
    loadSessions,
    selectedAgentId,
    selectedSessionId,
  ]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingSessionId && renameSessionInputRef.current) {
      renameSessionInputRef.current.focus();
      renameSessionInputRef.current.select();
    }
  }, [renamingSessionId]);

  useEffect(() => {
    if (renamingAgentId && renameAgentInputRef.current) {
      renameAgentInputRef.current.focus();
      renameAgentInputRef.current.select();
    }
  }, [renamingAgentId]);

  const initials =
    user.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "U";

  const toggleExpanded = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const handleCreateAgent = async () => {
    const trimmed = newAgentName.trim();
    if (!trimmed) return;
    try {
      const created = await createAgent(trimmed);
      setNewAgentName("");
      setShowNewAgent(false);
      navigate(`/agents/${created.id}`);
    } catch (error) {
      console.error("Failed to create agent:", error);
    }
  };

  const handleNewConversation = async (
    event: React.MouseEvent,
    agentId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setExpandedAgents((prev) => new Set([...prev, agentId]));
    try {
      const session = await createNewSession(agentId);
      navigate(`/agents/${agentId}/c/${session.id}`);
    } catch (error) {
      console.error("Failed to create session:", error);
    }
  };

  const handleRenameSession = async (sessionId: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingSessionId(null);
      return;
    }
    try {
      await renameSession(sessionId, trimmed);
    } catch (error) {
      console.error("Failed to rename session:", error);
    }
    setRenamingSessionId(null);
  };

  const handleDeleteSession = async (agentId: string, sessionId: string) => {
    try {
      await removeSession(agentId, sessionId);
      if (selectedSessionId === sessionId) {
        navigate(`/agents/${agentId}`, { replace: true });
      }
    } catch (error) {
      console.error("Failed to delete session:", error);
    }
  };

  const startRenameSession = (sessionId: string, currentTitle: string) => {
    setRenamingSessionId(sessionId);
    setRenameValue(currentTitle);
  };

  const startRenameAgent = (agentId: string, currentName: string) => {
    setRenamingAgentId(agentId);
    setRenameAgentValue(currentName);
  };

  const handleRenameAgent = async (agentId: string) => {
    const trimmed = renameAgentValue.trim();
    if (!trimmed) {
      setRenamingAgentId(null);
      setRenameAgentValue("");
      return;
    }
    try {
      await updateAgent(agentId, { name: trimmed });
      setRenamingAgentId(null);
      setRenameAgentValue("");
    } catch (error) {
      console.error("Failed to rename agent:", error);
    }
  };

  const handleDeleteAgent = async () => {
    if (!deleteAgentTarget) return;
    try {
      setAgentActionLoading(true);
      await deleteAgent(deleteAgentTarget.id);
      if (selectedAgentId === deleteAgentTarget.id) {
        navigate("/agents", { replace: true });
      }
      setDeleteAgentTarget(null);
    } catch (error) {
      console.error("Failed to delete agent:", error);
    } finally {
      setAgentActionLoading(false);
    }
  };

  return (
    <Sidebar className="border-r-0">
      {/* Brand header */}
      <SidebarHeader className="px-4 py-5">
        <Link to="/agents" className="flex items-center min-w-0">
          <div className="text-[15px] font-bold tracking-tight text-sidebar-foreground">
            Mines <span className="text-sidebar-primary">AI</span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {/* New agent */}
        <SidebarGroup>
          <SidebarGroupContent>
            {showNewAgent ? (
              <div className="space-y-2 rounded-lg bg-sidebar-accent/50 p-2">
                <Input
                  value={newAgentName}
                  onChange={(event) => setNewAgentName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleCreateAgent();
                    if (event.key === "Escape") {
                      setShowNewAgent(false);
                      setNewAgentName("");
                    }
                  }}
                  placeholder="Agent name..."
                  className="h-8 rounded-md border-sidebar-border bg-sidebar-accent text-[13px] text-sidebar-foreground placeholder:text-sidebar-foreground/40"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    className="h-7 flex-1 rounded-md bg-sidebar-primary text-[12px] font-semibold text-sidebar-primary-foreground hover:bg-sidebar-primary/90"
                    onClick={() => void handleCreateAgent()}
                  >
                    Create
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-md text-[12px] text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    onClick={() => {
                      setShowNewAgent(false);
                      setNewAgentName("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="h-9 rounded-lg px-0 text-[13px] font-medium"
                    onClick={() => setShowNewAgent(true)}
                  >
                    <Plus className="size-4" />
                    <span>New Agent</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Navigation */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = pathname.startsWith(item.path);
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      className="h-9 rounded-lg px-0 text-[13px] font-medium"
                    >
                      <Link to={item.path}>
                        <Icon className="size-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <div className="px-3">
          <Separator className="bg-sidebar-border" />
        </div>

        {/* Agents with collapsible conversations */}
        <SidebarGroup className="flex min-h-0 flex-1">
          <SidebarGroupLabel className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
            Agents
          </SidebarGroupLabel>
          <SidebarGroupContent className="agents-scroll flex-1 overflow-y-auto">
            <SidebarMenu>
              {agents.map((agent) => {
                const isExpanded = expandedAgents.has(agent.id);
                const isBusy = busyAgentIds.has(agent.id);
                const agentSessions = sessions.get(agent.id) || [];
                const vmUiStatus = toVmUiStatus(
                  agent.vm_status,
                  agent.desired_vm_state,
                );
                const statusTitle =
                  vmUiStatus === "ready"
                    ? "Sandbox ready"
                    : vmUiStatus === "error"
                      ? "Sandbox error"
                      : vmUiStatus === "starting"
                        ? "Sandbox starting"
                        : "Agent asleep";

                return (
                  <Collapsible
                    key={agent.id}
                    open={isExpanded}
                    onOpenChange={() => toggleExpanded(agent.id)}
                  >
                    <SidebarMenuItem>
                      <div className="group/agent relative">
                        {renamingAgentId === agent.id ? (
                          <Input
                            ref={renameAgentInputRef}
                            value={renameAgentValue}
                            onChange={(event) =>
                              setRenameAgentValue(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter")
                                void handleRenameAgent(agent.id);
                              if (event.key === "Escape") {
                                setRenamingAgentId(null);
                                setRenameAgentValue("");
                              }
                            }}
                            onBlur={() => void handleRenameAgent(agent.id)}
                            className="h-9 text-[13px] border-sidebar-border bg-sidebar-accent text-sidebar-foreground"
                          />
                        ) : (
                          <>
                            <CollapsibleTrigger asChild>
                              <SidebarMenuButton
                                className="h-9 rounded-lg px-0 text-[13px] font-medium transition-[padding] group-hover/agent:pr-14"
                                isActive={selectedAgentId === agent.id}
                                onClick={() => navigate(`/agents/${agent.id}`)}
                              >
                                <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                  <ChevronRight
                                    className={cn(
                                      "absolute size-3.5 transition-all duration-200 opacity-0 group-hover/agent:opacity-100",
                                      isExpanded && "rotate-90",
                                    )}
                                  />
                                  <span
                                    title={statusTitle}
                                    className={cn(
                                      "absolute h-2.5 w-2.5 rounded-full transition-opacity duration-200 group-hover/agent:opacity-0",
                                      vmUiStatus === "ready" && "bg-green-500",
                                      vmUiStatus === "error" && "bg-red-500",
                                      vmUiStatus === "starting" &&
                                        "bg-amber-400",
                                      vmUiStatus === "idle" && "bg-slate-400",
                                    )}
                                  />
                                </span>
                                <span className="sr-only">{statusTitle}</span>
                                <span className="min-w-0 flex-1 truncate">
                                  {agent.name}
                                </span>
                                {isBusy && (
                                  <Loader2 className="ml-auto size-3 animate-spin text-sidebar-primary" />
                                )}
                              </SidebarMenuButton>
                            </CollapsibleTrigger>

                            {/* Agent actions on hover */}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={`Agent actions for ${agent.name}`}
                                  className="absolute right-7 top-1/2 z-10 -translate-y-1/2 rounded p-1 text-sidebar-foreground/40 invisible opacity-0 transition-opacity hover:text-sidebar-foreground group-hover/agent:visible group-hover/agent:opacity-100"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                  onPointerDown={(event) => {
                                    event.stopPropagation();
                                  }}
                                >
                                  <MoreHorizontal className="size-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                side="right"
                                align="start"
                                className="w-44"
                              >
                                <DropdownMenuItem
                                  onSelect={() =>
                                    startRenameAgent(agent.id, agent.name)
                                  }
                                >
                                  <Pencil className="mr-2 size-3.5" />
                                  Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-red-600 focus:text-red-600"
                                  onSelect={() =>
                                    setDeleteAgentTarget({
                                      id: agent.id,
                                      name: agent.name,
                                    })
                                  }
                                >
                                  <Trash2 className="mr-2 size-3.5" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <button
                              type="button"
                              aria-label={`New conversation`}
                              className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded p-1 text-sidebar-foreground/40 invisible opacity-0 transition-opacity hover:text-sidebar-foreground group-hover/agent:visible group-hover/agent:opacity-100"
                              onClick={(event) => {
                                void handleNewConversation(event, agent.id);
                              }}
                              onPointerDown={(event) => {
                                event.stopPropagation();
                              }}
                            >
                              <Plus className="size-3.5" />
                            </button>
                          </>
                        )}
                      </div>

                      <CollapsibleContent>
                        <SidebarMenuSub className="agents-scroll max-h-56 overflow-y-auto pr-1">
                          {agentSessions.length === 0 && (
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton className="text-sidebar-foreground/40 text-[12px] italic">
                                No conversations
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          )}
                          {agentSessions.map((session) => {
                            const isActive = selectedSessionId === session.id;
                            const title = session.title || "New conversation";

                            if (renamingSessionId === session.id) {
                              return (
                                <SidebarMenuSubItem key={session.id}>
                                  <Input
                                    ref={renameSessionInputRef}
                                    value={renameValue}
                                    onChange={(e) =>
                                      setRenameValue(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter")
                                        void handleRenameSession(session.id);
                                      if (e.key === "Escape")
                                        setRenamingSessionId(null);
                                    }}
                                    onBlur={() =>
                                      void handleRenameSession(session.id)
                                    }
                                    className="h-7 text-[12px] border-sidebar-border bg-sidebar-accent text-sidebar-foreground"
                                  />
                                </SidebarMenuSubItem>
                              );
                            }

                            return (
                              <SidebarMenuSubItem
                                key={session.id}
                                className="group/session relative"
                              >
                                <SidebarMenuSubButton
                                  asChild
                                  isActive={isActive}
                                  className="pr-0 text-[12px] transition-[padding] group-hover/session:pr-8 group-focus-within/session:pr-8"
                                >
                                  <Link
                                    to={`/agents/${agent.id}/c/${session.id}`}
                                  >
                                    <span className="min-w-0 flex-1 truncate">
                                      {title}
                                    </span>
                                  </Link>
                                </SidebarMenuSubButton>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={`Conversation actions for ${title}`}
                                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-sidebar-foreground/40 hover:text-sidebar-foreground opacity-0 group-hover/session:opacity-100 focus:opacity-100 focus-visible:opacity-100 transition-opacity"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                      }}
                                      onPointerDown={(event) => {
                                        event.stopPropagation();
                                      }}
                                    >
                                      <MoreHorizontal className="size-3.5" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    side="right"
                                    align="start"
                                    className="w-36"
                                  >
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        startRenameSession(session.id, title)
                                      }
                                    >
                                      <Pencil className="mr-2 size-3.5" />
                                      Rename
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className="text-red-600 focus:text-red-600"
                                      onSelect={() =>
                                        void handleDeleteSession(
                                          agent.id,
                                          session.id,
                                        )
                                      }
                                    >
                                      <Trash2 className="mr-2 size-3.5" />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </SidebarMenuSubItem>
                            );
                          })}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              })}
              {agents.length === 0 && (
                <div className="px-3 py-6 text-center">
                  <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-accent">
                    <MessageSquare className="size-5 text-sidebar-foreground/30" />
                  </div>
                  <p className="text-[12px] text-sidebar-foreground/40">
                    No agents yet
                  </p>
                </div>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* User footer */}
      <SidebarFooter className="p-3">
        <div
          className={cn(
            "overflow-hidden rounded-xl bg-sidebar-accent/60 transition-all duration-200",
            showUserMenu ? "pb-1" : "",
          )}
        >
          <button
            type="button"
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-sidebar-accent"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sidebar-primary to-sidebar-primary/70 text-[11px] font-bold text-sidebar-primary-foreground shadow-sm">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-sidebar-foreground">
                {user.name}
              </div>
              <div className="truncate text-[11px] text-sidebar-foreground/50">
                {user.email}
              </div>
            </div>
            <ChevronUp
              className={cn(
                "size-4 shrink-0 text-sidebar-foreground/40 transition-transform duration-200",
                showUserMenu ? "rotate-0" : "rotate-180",
              )}
            />
          </button>
          {showUserMenu && (
            <div className="px-2 pb-2">
              <button
                type="button"
                onClick={() => void logout()}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <LogOut className="size-3.5" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </SidebarFooter>

      <Dialog
        open={Boolean(deleteAgentTarget)}
        onOpenChange={(open) => {
          if (!open && !agentActionLoading) {
            setDeleteAgentTarget(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete agent?</DialogTitle>
            <DialogDescription>
              This will remove the agent, its VM, and its workspace data.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
            {deleteAgentTarget?.name}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteAgentTarget(null)}
              disabled={agentActionLoading}
            >
              Cancel
            </Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => void handleDeleteAgent()}
              disabled={agentActionLoading}
            >
              {agentActionLoading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  Deleting...
                </span>
              ) : (
                "Delete agent"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
