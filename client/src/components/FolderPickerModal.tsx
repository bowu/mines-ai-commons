import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  type WorkspaceFile,
  createWorkspaceDir,
  listWorkspaceFiles,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface FolderPickerModalProps {
  agentId: string;
  currentFolder: string | null;
  onSelect: (path: string | null) => void;
  onClose: () => void;
}

type FolderNode = WorkspaceFile & {
  type: "directory";
  children?: FolderNode[];
  childrenLoaded?: boolean;
};

const HIDDEN_FOLDERS = new Set([
  "skills",
  "venv",
  ".venv",
  ".pi",
  "node_modules",
]);

function isHiddenFolderName(name: string): boolean {
  return name.startsWith(".") || HIDDEN_FOLDERS.has(name);
}

function normalizeFolderTree(items: WorkspaceFile[]): FolderNode[] {
  return items
    .filter(
      (item): item is WorkspaceFile & { type: "directory" } =>
        item.type === "directory" && !isHiddenFolderName(item.name),
    )
    .map((item) => {
      const { children, ...rest } = item;
      if (Array.isArray(children)) {
        return {
          ...rest,
          childrenLoaded: true,
          children: normalizeFolderTree(children),
        };
      }
      return { ...rest, childrenLoaded: false };
    });
}

function findFolderNode(
  items: FolderNode[],
  targetPath: string,
): FolderNode | null {
  for (const item of items) {
    if (item.path === targetPath) return item;
    if (item.children?.length) {
      const found = findFolderNode(item.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function replaceFolderChildren(
  items: FolderNode[],
  targetPath: string,
  children: FolderNode[],
): FolderNode[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.path === targetPath) {
      changed = true;
      return {
        ...item,
        childrenLoaded: true,
        children,
      };
    }
    if (item.children?.length) {
      const replaced = replaceFolderChildren(
        item.children,
        targetPath,
        children,
      );
      if (replaced !== item.children) {
        changed = true;
        return { ...item, children: replaced };
      }
    }
    return item;
  });
  return changed ? next : items;
}

export function FolderPickerModal({
  agentId,
  currentFolder,
  onSelect,
  onClose,
}: FolderPickerModalProps) {
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [selected, setSelected] = useState<string>(currentFolder || "");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [folderLoadErrors, setFolderLoadErrors] = useState<
    Record<string, string>
  >({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const pendingLoadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const foldersRef = useRef<FolderNode[]>([]);
  const expandedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    setSelected(currentFolder || "");
  }, [currentFolder]);

  useEffect(() => {
    pendingLoadsRef.current.clear();
  }, [agentId]);

  const loadRootFolders = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await listWorkspaceFiles(agentId, {
        recursive: false,
        includeStats: false,
      });
      setFolders(normalizeFolderTree(data.files));
      setExpanded(new Set());
      setLoadingPaths(new Set());
      setFolderLoadErrors({});
    } catch (err) {
      console.error("Failed to load folders:", err);
      setFolders([]);
      setExpanded(new Set());
      setLoadingPaths(new Set());
      setFolderLoadErrors({});
      setLoadError(
        err instanceof Error ? err.message : "Failed to load folders",
      );
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void loadRootFolders();
  }, [loadRootFolders]);

  const ensureFolderLoaded = useCallback(
    async (dirPath: string) => {
      const existing = pendingLoadsRef.current.get(dirPath);
      if (existing) {
        await existing;
        return;
      }

      const node = findFolderNode(foldersRef.current, dirPath);
      if (!node || node.childrenLoaded) {
        return;
      }

      setFolderLoadErrors((prev) => {
        if (!(dirPath in prev)) return prev;
        const next = { ...prev };
        delete next[dirPath];
        return next;
      });
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.add(dirPath);
        return next;
      });

      const loadPromise = (async () => {
        const data = await listWorkspaceFiles(agentId, {
          path: dirPath,
          recursive: false,
          includeStats: false,
        });
        const children = normalizeFolderTree(data.files);
        setFolders((prev) => replaceFolderChildren(prev, dirPath, children));
      })();

      pendingLoadsRef.current.set(dirPath, loadPromise);
      try {
        await loadPromise;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load folder";
        setFolderLoadErrors((prev) => ({ ...prev, [dirPath]: message }));
        throw error;
      } finally {
        pendingLoadsRef.current.delete(dirPath);
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [agentId],
  );

  const handleToggleExpand = useCallback(
    (path: string) => {
      const isExpanded = expandedRef.current.has(path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      if (!isExpanded) {
        void ensureFolderLoaded(path).catch((error) => {
          console.error(`Failed to load folder ${path}:`, error);
        });
      }
    },
    [ensureFolderLoaded],
  );

  const reloadFoldersAfterMutation = useCallback(async () => {
    const previousExpanded = new Set(expandedRef.current);
    pendingLoadsRef.current.clear();
    await loadRootFolders();
    const sortedExpanded = Array.from(previousExpanded).sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );
    for (const path of sortedExpanded) {
      if (!path) continue;
      try {
        await ensureFolderLoaded(path);
      } catch (error) {
        console.error(`Failed to reload folder ${path}:`, error);
      }
    }
    setExpanded(previousExpanded);
  }, [ensureFolderLoaded, loadRootFolders]);

  const handleCreateFolder = async () => {
    const trimmedName = newFolderName.trim();
    if (!trimmedName) return;
    try {
      setCreating(true);
      setCreateError(null);
      const parentPath = selected || "";
      const fullPath = parentPath
        ? `${parentPath}/${trimmedName}`
        : trimmedName;
      await createWorkspaceDir(agentId, fullPath);
      setNewFolderName("");
      setShowNewFolder(false);
      setSelected(fullPath);
      await reloadFoldersAfterMutation();
    } catch (err) {
      console.error("Failed to create folder:", err);
      setCreateError(
        err instanceof Error ? err.message : "Failed to create folder",
      );
    } finally {
      setCreating(false);
    }
  };

  const handleConfirm = () => {
    onSelect(selected || null);
    onClose();
  };

  const handleClear = () => {
    onSelect(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 z-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 flex max-h-[500px] w-[420px] flex-col rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div>
            <div className="text-sm font-semibold text-foreground">
              Choose Output Folder
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              Files created by the agent will be saved here
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Folder tree */}
        <ScrollArea className="flex-1 min-h-[200px] max-h-[300px]">
          <div className="p-3">
            {/* Root workspace option */}
            <button
              type="button"
              onClick={() => setSelected("")}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors",
                selected === ""
                  ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
                  : "hover:bg-muted text-foreground",
              )}
            >
              <FolderOpen className="w-4 h-4 shrink-0" />
              <span className="font-medium">/ (workspace root)</span>
              {selected === "" && (
                <Check className="w-3.5 h-3.5 ml-auto text-blue-600" />
              )}
            </button>

            {/* Folder items */}
            {loading ? (
              <div className="text-center py-8 text-xs text-muted-foreground">
                Loading...
              </div>
            ) : loadError ? (
              <div className="text-center py-8 text-xs text-red-600">
                {loadError}
              </div>
            ) : (
              <FolderList
                items={folders}
                selected={selected}
                expanded={expanded}
                loadingPaths={loadingPaths}
                folderLoadErrors={folderLoadErrors}
                onSelect={setSelected}
                onToggleExpand={handleToggleExpand}
                depth={0}
              />
            )}
          </div>
        </ScrollArea>

        {/* New folder input */}
        <div className="px-4 py-2 border-t border-border">
          {showNewFolder ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleCreateFolder();
                    }
                  }}
                  placeholder="Folder name..."
                  className="text-xs h-8"
                  autoFocus
                />
                <Button
                  type="button"
                  onClick={() => void handleCreateFolder()}
                  size="sm"
                  className="h-8 text-xs bg-mines-light-blue hover:bg-mines-light-blue/90"
                  disabled={!newFolderName.trim() || creating}
                >
                  {creating ? "Creating..." : "Create"}
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setShowNewFolder(false);
                    setNewFolderName("");
                    setCreateError(null);
                  }}
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={creating}
                >
                  Cancel
                </Button>
              </div>
              {createError && (
                <p className="text-[11px] text-red-600">{createError}</p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowNewFolder(true)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                New folder{selected ? ` in /${selected}` : ""}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/30 rounded-b-xl">
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              className="text-xs h-8"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleConfirm}
              className="text-xs h-8 bg-mines-blue hover:bg-mines-blue/90"
            >
              {selected ? `Select /${selected}` : "Select root"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FolderList({
  items,
  selected,
  expanded,
  loadingPaths,
  folderLoadErrors,
  onSelect,
  onToggleExpand,
  depth,
}: {
  items: FolderNode[];
  selected: string;
  expanded: Set<string>;
  loadingPaths: Set<string>;
  folderLoadErrors: Record<string, string>;
  onSelect: (path: string) => void;
  onToggleExpand: (path: string) => void;
  depth: number;
}) {
  if (items.length === 0) return null;

  return (
    <>
      {items.map((item) => {
        const isExpanded = expanded.has(item.path);
        const isLoadingChildren = loadingPaths.has(item.path);
        const loadError = folderLoadErrors[item.path];

        return (
          <div key={item.path}>
            <div
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors cursor-pointer",
                selected === item.path
                  ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
                  : "hover:bg-muted text-foreground",
              )}
              style={{ paddingLeft: `${12 + depth * 20}px` }}
              onClick={() => onSelect(item.path)}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(item.path);
                }}
                className="p-0.5 -m-0.5 rounded hover:bg-black/10 transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
                )}
              </button>
              <Folder className="w-4 h-4 shrink-0 text-mines-gold" />
              <span className="truncate">{item.name}</span>
              {isLoadingChildren ? (
                <span className="text-[10px] text-muted-foreground">
                  Loading...
                </span>
              ) : loadError ? (
                <span className="text-[10px] text-red-600">Failed</span>
              ) : null}
              {selected === item.path && (
                <Check className="w-3.5 h-3.5 ml-auto text-blue-600" />
              )}
            </div>
            {isExpanded && item.children && item.children.length > 0 && (
              <FolderList
                items={item.children}
                selected={selected}
                expanded={expanded}
                loadingPaths={loadingPaths}
                folderLoadErrors={folderLoadErrors}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
