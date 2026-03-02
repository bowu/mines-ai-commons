import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AgentSkill } from "@/lib/api";
import { Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

interface AgentSkillsDrawerProps {
  agentSkills: AgentSkill[];
  onRemoveSkill: (skillId: string) => void;
  onInstallSkills: (skillIds: string[]) => void;
}

export function AgentSkillsDrawer({
  agentSkills,
  onRemoveSkill,
  onInstallSkills,
}: AgentSkillsDrawerProps) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

  const visibleSkills = useMemo(
    () => agentSkills.filter((skill) => skill.tool_type !== "web_search"),
    [agentSkills],
  );
  const installedSkills = visibleSkills.filter((skill) => skill.installed);
  const availableSkills = visibleSkills.filter((skill) => !skill.installed);
  const filteredAvailable = availableSkills.filter(
    (skill) =>
      !search ||
      skill.name.toLowerCase().includes(search.toLowerCase()) ||
      skill.description.toLowerCase().includes(search.toLowerCase()),
  );

  const toggleSelected = (skillId: string) => {
    setSelectedSkillIds((prev) =>
      prev.includes(skillId)
        ? prev.filter((id) => id !== skillId)
        : [...prev, skillId],
    );
  };

  const handleInstall = () => {
    if (selectedSkillIds.length === 0) return;
    onInstallSkills(selectedSkillIds);
    setSelectedSkillIds([]);
    setSearch("");
    setShowAddModal(false);
  };

  return (
    <div className="w-[320px] bg-white border-l border-border shrink-0">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Installed Skills
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {installedSkills.length} installed
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => setShowAddModal(true)}
          className="h-8 text-xs"
        >
          <Plus className="w-3.5 h-3.5 mr-1" />
          Add Skill
        </Button>
      </div>

      <ScrollArea className="h-[calc(100%-65px)]">
        <div className="p-3 space-y-2">
          {installedSkills.map((skill) => (
            <div
              key={skill.id}
              className="flex items-start gap-2 rounded-lg border border-border px-3 py-2"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-foreground">
                  {skill.name}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {skill.description}
                </div>
              </div>
              <button
                onClick={() => onRemoveSkill(skill.id)}
                className="mt-0.5 text-muted-foreground hover:text-red-500"
                title="Remove skill"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {installedSkills.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-8">
              No installed skills yet.
            </div>
          )}
        </div>
      </ScrollArea>

      <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
        <DialogContent className="max-w-[720px]">
          <DialogHeader>
            <DialogTitle>Skills Library</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search skills..."
                className="pl-9"
              />
            </div>
            <ScrollArea className="h-[360px] pr-2">
              <div className="space-y-2">
                {filteredAvailable.map((skill) => (
                  <label
                    key={skill.id}
                    className="flex items-start gap-3 rounded-lg border border-border px-3 py-2 cursor-pointer hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSkillIds.includes(skill.id)}
                      onChange={() => toggleSelected(skill.id)}
                      className="mt-1"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {skill.name}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {skill.description}
                      </div>
                      {skill.when_to_use && (
                        <div className="text-[11px] text-muted-foreground mt-1">
                          {skill.when_to_use.slice(0, 140)}
                          {skill.when_to_use.length > 140 ? "..." : ""}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
                {filteredAvailable.length === 0 && (
                  <div className="text-xs text-muted-foreground text-center py-8">
                    {availableSkills.length === 0
                      ? "All available skills are already installed."
                      : "No skills match your search."}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleInstall}
              disabled={selectedSkillIds.length === 0}
            >
              Install Selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
