import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SectionCard } from "@/components/ui/section-card";
import { Textarea } from "@/components/ui/textarea";
import {
  type Skill,
  createSkill,
  deleteSkill,
  listSkills,
  updateSkill,
} from "@/lib/api";
import { FlaskConical, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

const SKILL_ICONS: Record<string, string> = {
  "web search": "🌐",
};

function getSkillIcon(name: string): string {
  return SKILL_ICONS[name.toLowerCase()] || "⚡";
}

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [form, setForm] = useState({
    name: "",
    when_to_use: "",
    instructions: "",
  });
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    try {
      const nextSkills = await listSkills();
      setSkills(nextSkills);
      return nextSkills;
    } catch (err) {
      console.error(err);
      return [];
    }
  };

  const openCreate = () => {
    setEditingSkill(null);
    setForm({ name: "", when_to_use: "", instructions: "" });
    setSelectedFiles([]);
    setShowModal(true);
  };

  const openEdit = (skill: Skill) => {
    setEditingSkill(skill);
    setForm({
      name: skill.name,
      when_to_use: skill.when_to_use,
      instructions: skill.instructions,
    });
    setSelectedFiles([]);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    try {
      const payload = { ...form };
      if (editingSkill) {
        await updateSkill(editingSkill.id, payload, selectedFiles);
      } else {
        await createSkill(payload, selectedFiles);
      }
      await loadSkills();
      setShowModal(false);
      setSelectedFiles([]);
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this skill?")) return;
    try {
      await deleteSkill(id);
      setSkills((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      console.error(err);
    }
  };

  const visibleSkills = skills.filter((s) => s.tool_type !== "web_search");
  const filtered = visibleSkills.filter(
    (s) =>
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <PageShell data-testid="skills-page">
      <PageHeader
        icon={
          <FlaskConical className="w-[18px] h-[18px] text-mines-light-blue" />
        }
        title="Skills Library"
        subtitle="Skills = instructions + data sources. Available to all agents."
        actions={
          <Button
            onClick={openCreate}
            className="bg-mines-blue hover:bg-mines-blue/90"
          >
            <Plus className="w-4 h-4 mr-1" />
            Create Skill
          </Button>
        }
      />

      {/* Search */}
      <div className="relative mb-6">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills..."
          className="pl-9"
        />
      </div>

      <div className="space-y-3">
        {filtered.map((skill) => (
          <div key={skill.id} className="relative">
            <SectionCard
              interactive
              onClick={() => openEdit(skill)}
              className="flex items-center gap-4 px-5 py-4 pr-14"
            >
              <div className="w-10 h-10 rounded-lg bg-mines-light-blue/10 flex items-center justify-center text-lg">
                {getSkillIcon(skill.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-ink">
                  {skill.name}
                </div>
                {skill.when_to_use && (
                  <div className="text-xs text-ink-muted mt-0.5">
                    When to use: {skill.when_to_use.slice(0, 120)}
                    {skill.when_to_use.length > 120 ? "..." : ""}
                  </div>
                )}
              </div>
              {skill.tool_type && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-green-200 text-green-700 bg-green-50"
                >
                  {skill.tool_type === "web_search"
                    ? "Web Search"
                    : skill.tool_type}
                </Badge>
              )}
              <Badge variant="secondary" className="text-[10px]">
                {new Date(skill.updated_at).toLocaleDateString()}
              </Badge>
            </SectionCard>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Delete ${skill.name}`}
              onClick={() => handleDelete(skill.id)}
              className="absolute right-3 top-1/2 -translate-y-1/2 h-8 w-8 p-0 text-muted-foreground hover:text-red-500 z-10"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center py-12 text-ink-muted text-sm">
            {search
              ? "No skills match your search."
              : "No skills yet. Create one to get started."}
          </div>
        )}
      </div>

      {/* Create/Edit modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[980px]">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold text-ink">
              {editingSkill ? (
                <span className="flex items-center gap-2">
                  <Pencil className="w-4 h-4" /> Edit Skill
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Plus className="w-4 h-4" /> Create New Skill
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[72vh]">
            <div className="space-y-4 pr-4">
              <div>
                <label className="block text-sm font-semibold text-foreground mb-1">
                  Skill Name
                </label>
                <Input
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="e.g., Grant Finder, Course Advisor..."
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-foreground mb-1">
                  When to Use
                </label>
                <p className="text-[11px] text-muted-foreground mb-1">
                  When should the agent activate this skill?
                </p>
                <Textarea
                  value={form.when_to_use}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, when_to_use: e.target.value }))
                  }
                  placeholder="When the user asks about..."
                  className="min-h-[80px] resize-y"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-foreground mb-1">
                  Instructions
                </label>
                <p className="text-[11px] text-muted-foreground mb-1">
                  Step-by-step instructions for the agent
                </p>
                <Textarea
                  value={form.instructions}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, instructions: e.target.value }))
                  }
                  placeholder={
                    "1. Search for...\n2. Filter by...\n3. Present results with..."
                  }
                  className="min-h-[120px] resize-y font-mono text-xs"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-foreground mb-1">
                  Upload Files (Optional)
                </label>
                <p className="text-[11px] text-muted-foreground mb-2">
                  Uploaded files become data sources in this skill package.
                  Name, description, when-to-use, and instructions are
                  auto-written to <code>SKILL.md</code>.
                </p>
                <Input
                  type="file"
                  multiple
                  onChange={(e) =>
                    setSelectedFiles(Array.from(e.target.files || []))
                  }
                />
                {editingSkill &&
                  (editingSkill.data_source_files?.length || 0) > 0 && (
                    <div className="mt-2 rounded-md border bg-muted/20 p-2 text-xs">
                      Attached files ({editingSkill.data_source_files!.length}
                      ):
                      <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
                        {editingSkill.data_source_files!.join(", ")}
                      </div>
                    </div>
                  )}
                {selectedFiles.length > 0 && (
                  <div className="mt-2 rounded-md border bg-muted/30 p-2 text-xs">
                    New files to add ({selectedFiles.length}):
                    <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
                      {selectedFiles.map((file) => file.name).join(", ")}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              className="bg-mines-blue hover:bg-mines-blue/90"
            >
              {editingSkill ? "Save Changes" : "Create Skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
