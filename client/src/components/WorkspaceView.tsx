import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  type WorkspaceFile,
  createWorkspaceDir,
  deleteWorkspaceFile,
  listWorkspaceFiles,
  moveWorkspaceFile,
  readWorkspaceFile,
  uploadWorkspaceFile,
} from "@/lib/api";
import {
  getFileTypeBadge,
  getMonacoLanguage,
  getRawUrl as getRawUrlUtil,
  isCode,
  isDocx,
  isHtml,
  isImage,
  isMd,
  isPdf,
  isPptx,
  isRichDoc,
} from "@/lib/file-utils";
import { cn } from "@/lib/utils";
import {
  type MouseEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
const PdfViewer = lazy(() =>
  import("./PdfViewer").then((m) => ({ default: m.PdfViewer })),
);
const DocxViewer = lazy(() =>
  import("./DocxViewer").then((m) => ({ default: m.DocxViewer })),
);
const XlsxViewer = lazy(() =>
  import("./XlsxViewer").then((m) => ({ default: m.XlsxViewer })),
);
const PptxViewer = lazy(() =>
  import("./PptxViewer").then((m) => ({ default: m.PptxViewer })),
);
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  File,
  FileText,
  Folder,
  FolderPlus,
  Trash2,
  Upload,
} from "lucide-react";
import { CodeViewer } from "./CodeViewer";
import { MarkdownViewer } from "./MarkdownViewer";
import { PdfZoomControls } from "./PdfZoomControls";
import { SandboxedHtmlPreview } from "./SandboxedHtmlPreview";

interface WorkspaceViewProps {
  agentId: string;
  agentName?: string;
  selectedFilePath?: string | null;
  onSelectedFilePathChange?: (path: string | null) => void;
}

type WorkspaceTreeNode = WorkspaceFile & {
  children?: WorkspaceTreeNode[];
  childrenLoaded?: boolean;
};

const HIDDEN_ENTRY_NAMES = new Set([
  "skills",
  "venv",
  ".venv",
  ".pi",
  "node_modules",
]);

function isHiddenWorkspaceEntry(name: string): boolean {
  return name.startsWith(".") || HIDDEN_ENTRY_NAMES.has(name);
}

function normalizeWorkspaceTree(items: WorkspaceFile[]): WorkspaceTreeNode[] {
  return items
    .filter((item) => !isHiddenWorkspaceEntry(item.name))
    .map((item) => {
      if (item.type !== "directory") {
        return item;
      }
      if (Array.isArray(item.children)) {
        return {
          ...item,
          childrenLoaded: true,
          children: normalizeWorkspaceTree(item.children),
        };
      }
      return { ...item, childrenLoaded: false };
    });
}

function replaceDirectoryChildren(
  items: WorkspaceTreeNode[],
  targetPath: string,
  children: WorkspaceTreeNode[],
): WorkspaceTreeNode[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.type === "directory" && item.path === targetPath) {
      changed = true;
      return {
        ...item,
        childrenLoaded: true,
        children,
      };
    }
    if (item.type === "directory" && item.children?.length) {
      const replaced = replaceDirectoryChildren(
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

function flattenVisibleItemPaths(
  items: WorkspaceTreeNode[],
  expandedDirs: Set<string>,
): string[] {
  const paths: string[] = [];

  const visit = (nodes: WorkspaceTreeNode[]) => {
    for (const node of nodes) {
      paths.push(node.path);
      if (
        node.type === "directory" &&
        expandedDirs.has(node.path) &&
        node.children?.length
      ) {
        visit(node.children);
      }
    }
  };

  visit(items);
  return paths;
}

function normalizeSelectedPath(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const normalized = value.replace(/^\/+/, "").replace(/\\/g, "/").trim();
  return normalized.length > 0 ? normalized : null;
}

export function WorkspaceView({
  agentId,
  selectedFilePath,
  onSelectedFilePathChange,
}: WorkspaceViewProps) {
  const [files, setFiles] = useState<WorkspaceTreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [pdfScale, setPdfScale] = useState(1.0);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(
    null,
  );
  const [fileContent, setFileContent] = useState<string>("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileMeta, setFileMeta] = useState<{
    size: number;
    modified: string;
  } | null>(null);
  const [focusedDir, setFocusedDir] = useState<string>("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [directoryLoadErrors, setDirectoryLoadErrors] = useState<
    Record<string, string>
  >({});
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pendingDirLoadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const filesRef = useRef<WorkspaceTreeNode[]>([]);
  const expandedDirsRef = useRef<Set<string>>(new Set());
  const directoryLoadErrorsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    expandedDirsRef.current = expandedDirs;
  }, [expandedDirs]);

  useEffect(() => {
    directoryLoadErrorsRef.current = directoryLoadErrors;
  }, [directoryLoadErrors]);

  useEffect(() => {
    pendingDirLoadsRef.current.clear();
  }, [agentId]);

  const normalizedSelectedFilePath = useMemo(
    () => normalizeSelectedPath(selectedFilePath),
    [selectedFilePath],
  );

  const emitSelectedFilePathChange = useCallback(
    (filePath: string | null) => {
      const normalizedNextPath = normalizeSelectedPath(filePath);
      if (normalizedNextPath === normalizedSelectedFilePath) return;
      onSelectedFilePathChange?.(normalizedNextPath);
    },
    [normalizedSelectedFilePath, onSelectedFilePathChange],
  );

  useEffect(() => {
    setPdfScale(1.0);
  }, [selectedFile]);

  const findFileInTree = (
    items: WorkspaceTreeNode[],
    targetPath: string,
  ): WorkspaceTreeNode | null => {
    for (const item of items) {
      if (item.path === targetPath) return item;
      if (item.children) {
        const found = findFileInTree(item.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  };

  const loadRootDirectory = useCallback(async () => {
    try {
      const data = await listWorkspaceFiles(agentId, {
        recursive: false,
        includeStats: false,
      });
      setFiles(normalizeWorkspaceTree(data.files));
      setExpandedDirs(new Set());
      setLoadingDirs(new Set());
      setDirectoryLoadErrors({});
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load workspace files:", err);
      setFiles([]);
      setDirectoryLoadErrors({});
      setLoadError(
        err instanceof Error ? err.message : "Failed to load workspace files",
      );
    }
  }, [agentId]);

  const ensureDirectoryLoaded = useCallback(
    async (dirPath: string) => {
      const existing = pendingDirLoadsRef.current.get(dirPath);
      if (existing) {
        await existing;
        return;
      }

      const node = findFileInTree(filesRef.current, dirPath);
      if (!node || node.type !== "directory" || node.childrenLoaded) {
        return;
      }

      setDirectoryLoadErrors((prev) => {
        if (!(dirPath in prev)) return prev;
        const next = { ...prev };
        delete next[dirPath];
        return next;
      });
      setLoadingDirs((prev) => {
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
        const children = normalizeWorkspaceTree(data.files);
        setFiles((prev) => replaceDirectoryChildren(prev, dirPath, children));
      })();

      pendingDirLoadsRef.current.set(dirPath, loadPromise);
      try {
        await loadPromise;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load folder";
        setDirectoryLoadErrors((prev) => ({ ...prev, [dirPath]: message }));
        throw error;
      } finally {
        pendingDirLoadsRef.current.delete(dirPath);
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [agentId],
  );

  useEffect(() => {
    void loadRootDirectory();
  }, [loadRootDirectory]);

  const displayFiles = files;
  const visibleItemPaths = useMemo(
    () => flattenVisibleItemPaths(displayFiles, expandedDirs),
    [displayFiles, expandedDirs],
  );

  const handleSelectFile = useCallback(
    async (
      filePath: string,
      options?: {
        syncUrl?: boolean;
      },
    ) => {
      const syncUrl = options?.syncUrl ?? true;
      setSelectedFile((prev) => (prev === filePath ? prev : filePath));
      if (syncUrl) {
        emitSelectedFilePathChange(filePath);
      }
      setFileContent("");
      setFileMeta(null);
      if (isRichDoc(filePath) && !isHtml(filePath)) {
        // Rich documents use URL-based rendering, no text extraction needed
        const file = findFileInTree(displayFiles, filePath);
        if (file) {
          setFileMeta({ size: file.size || 0, modified: file.modified || "" });
        }
        return;
      }
      setFileLoading(true);
      try {
        const data = await readWorkspaceFile(agentId, filePath);
        setFileContent(data.content);
        setFileMeta({ size: data.size, modified: data.modified });
      } catch (err) {
        console.error("Failed to read file:", err);
        setFileContent("Error reading file");
      } finally {
        setFileLoading(false);
      }
    },
    [agentId, displayFiles, emitSelectedFilePathChange],
  );

  useEffect(() => {
    if (normalizedSelectedFilePath === selectedFile) {
      return;
    }
    if (!normalizedSelectedFilePath) {
      setSelectedFile(null);
      setFileContent("");
      setFileMeta(null);
      return;
    }
    void handleSelectFile(normalizedSelectedFilePath, { syncUrl: false });
  }, [normalizedSelectedFilePath, selectedFile, handleSelectFile]);

  const getRawUrl = (filePath: string) => getRawUrlUtil(agentId, filePath);

  const joinPath = (base: string, name: string): string =>
    base ? `${base}/${name}` : name;

  const parentDirOf = (itemPath: string): string => {
    const idx = itemPath.lastIndexOf("/");
    return idx === -1 ? "" : itemPath.slice(0, idx);
  };

  const directoryPaths = useMemo(() => {
    const set = new Set<string>();
    const visit = (items: WorkspaceTreeNode[]) => {
      for (const item of items) {
        if (item.type === "directory") {
          set.add(item.path);
          if (item.children?.length) {
            visit(item.children);
          }
        }
      }
    };
    visit(displayFiles);
    return set;
  }, [displayFiles]);

  useEffect(() => {
    if (focusedDir && !directoryPaths.has(focusedDir)) {
      setFocusedDir("");
    }
  }, [focusedDir, directoryPaths]);

  useEffect(() => {
    const visible = new Set(visibleItemPaths);

    setSelectedPaths((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (visible.has(p)) {
          next.add(p);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    if (selectionAnchorPath && !visible.has(selectionAnchorPath)) {
      setSelectionAnchorPath(null);
    }
  }, [visibleItemPaths, selectionAnchorPath]);

  useEffect(() => {
    setExpandedDirs((prev) => {
      const next = new Set<string>();
      for (const dir of prev) {
        if (directoryPaths.has(dir)) {
          next.add(dir);
        }
      }
      return next;
    });
    setLoadingDirs((prev) => {
      const next = new Set<string>();
      for (const dir of prev) {
        if (directoryPaths.has(dir)) {
          next.add(dir);
        }
      }
      return next;
    });
  }, [directoryPaths]);

  const handleTreeItemClick = useCallback(
    (item: WorkspaceTreeNode, event: MouseEvent<HTMLDivElement>) => {
      const clickedPath = item.path;
      const isToggle = event.metaKey || event.ctrlKey;
      const isRange = event.shiftKey;

      setSelectedPaths((prev) => {
        if (isRange && selectionAnchorPath) {
          const anchorIndex = visibleItemPaths.indexOf(selectionAnchorPath);
          const clickedIndex = visibleItemPaths.indexOf(clickedPath);
          if (anchorIndex !== -1 && clickedIndex !== -1) {
            const start = Math.min(anchorIndex, clickedIndex);
            const end = Math.max(anchorIndex, clickedIndex);
            const range = visibleItemPaths.slice(start, end + 1);
            if (isToggle) {
              const next = new Set(prev);
              for (const p of range) {
                next.add(p);
              }
              return next;
            }
            return new Set(range);
          }
        }

        if (isToggle) {
          const next = new Set(prev);
          if (next.has(clickedPath)) {
            next.delete(clickedPath);
          } else {
            next.add(clickedPath);
          }
          return next;
        }

        return new Set([clickedPath]);
      });

      if (!isRange) {
        setSelectionAnchorPath(clickedPath);
      }

      if (!isToggle && !isRange) {
        if (item.type === "file") {
          void handleSelectFile(clickedPath);
        } else {
          setFocusedDir(clickedPath);
        }
      }
    },
    [selectionAnchorPath, visibleItemPaths, handleSelectFile],
  );

  const handleToggleDirectory = useCallback(
    (dirPath: string) => {
      const isExpanded = expandedDirsRef.current.has(dirPath);
      const hasLoadError = Boolean(directoryLoadErrorsRef.current[dirPath]);
      if (isExpanded && hasLoadError) {
        void ensureDirectoryLoaded(dirPath).catch((error) => {
          console.error(`Failed to retry folder ${dirPath}:`, error);
        });
        return;
      }
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });
      if (!isExpanded) {
        void ensureDirectoryLoaded(dirPath).catch((error) => {
          console.error(`Failed to load folder ${dirPath}:`, error);
        });
      }
    },
    [ensureDirectoryLoaded],
  );

  const reloadTreeAfterMutation = useCallback(async () => {
    const previousExpanded = new Set(expandedDirsRef.current);
    const previousFocused = focusedDir;
    pendingDirLoadsRef.current.clear();
    await loadRootDirectory();
    const sortedExpanded = Array.from(previousExpanded).sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );
    for (const path of sortedExpanded) {
      if (!path) continue;
      try {
        await ensureDirectoryLoaded(path);
      } catch (error) {
        console.error(`Failed to reload directory ${path}:`, error);
      }
    }
    setExpandedDirs(previousExpanded);
    if (previousFocused) {
      setFocusedDir(previousFocused);
    }
  }, [ensureDirectoryLoaded, focusedDir, loadRootDirectory]);

  const handleUpload = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        await uploadWorkspaceFile(agentId, file, focusedDir || undefined);
        await reloadTreeAfterMutation();
      } catch (err) {
        console.error("Failed to upload file:", err);
      }
    };
    input.click();
  };

  const handleNewFolder = async () => {
    const name = prompt("Folder name:");
    if (!name?.trim()) return;
    try {
      const nextPath = joinPath(focusedDir, name.trim());
      await createWorkspaceDir(agentId, nextPath);
      await reloadTreeAfterMutation();
    } catch (err) {
      console.error("Failed to create folder:", err);
    }
  };

  const handleDelete = async (filePath: string) => {
    if (!confirm(`Delete ${filePath}?`)) return;
    try {
      await deleteWorkspaceFile(agentId, filePath);
      if (
        selectedFile === filePath ||
        selectedFile?.startsWith(`${filePath}/`)
      ) {
        setSelectedFile(null);
        setFileContent("");
        setFileMeta(null);
        emitSelectedFilePathChange(null);
      }
      if (focusedDir === filePath || focusedDir.startsWith(`${filePath}/`)) {
        setFocusedDir(parentDirOf(filePath));
      }
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      await reloadTreeAfterMutation();
    } catch (err) {
      console.error("Failed to delete file:", err);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedPaths.size === 0) return;
    const paths = Array.from(selectedPaths);
    const label = paths.length === 1 ? paths[0] : `${paths.length} items`;
    if (!confirm(`Delete ${label}?`)) return;

    // Sort paths longest-first so nested items are deleted before parents
    paths.sort((a, b) => b.length - a.length);

    for (const filePath of paths) {
      try {
        await deleteWorkspaceFile(agentId, filePath);
      } catch (err) {
        console.error(`Failed to delete ${filePath}:`, err);
      }
    }

    if (
      selectedFile &&
      paths.some((p) => selectedFile === p || selectedFile.startsWith(`${p}/`))
    ) {
      setSelectedFile(null);
      setFileContent("");
      setFileMeta(null);
      emitSelectedFilePathChange(null);
    }
    if (
      focusedDir &&
      paths.some((p) => focusedDir === p || focusedDir.startsWith(`${p}/`))
    ) {
      setFocusedDir("");
    }
    setSelectedPaths(new Set());
    await reloadTreeAfterMutation();
  };

  const handleMove = async (fromPath: string, toDirPath: string) => {
    const currentParent = parentDirOf(fromPath);
    if (currentParent === toDirPath) {
      return;
    }

    try {
      const moved = await moveWorkspaceFile(agentId, fromPath, toDirPath);
      setDraggingPath(null);
      setDropTargetDir(null);
      await reloadTreeAfterMutation();

      if (selectedFile) {
        let updatedSelection: string | null = null;
        if (selectedFile === moved.from) {
          updatedSelection = moved.to;
        } else if (selectedFile.startsWith(`${moved.from}/`)) {
          updatedSelection = `${moved.to}${selectedFile.slice(moved.from.length)}`;
        }

        if (updatedSelection) {
          await handleSelectFile(updatedSelection);
        }
      }
      if (focusedDir) {
        if (focusedDir === moved.from) {
          setFocusedDir(moved.to);
        } else if (focusedDir.startsWith(`${moved.from}/`)) {
          setFocusedDir(`${moved.to}${focusedDir.slice(moved.from.length)}`);
        }
      }
    } catch (err) {
      console.error("Failed to move file:", err);
      alert(err instanceof Error ? err.message : "Failed to move file");
    }
  };

  const handleDownload = () => {
    if (!selectedFile) return;
    const url = `/api/workspace/${agentId}/file?path=${encodeURIComponent(selectedFile)}&download=true`;
    const a = document.createElement("a");
    a.href = url;
    a.download = selectedFile.split("/").pop() || "download";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(fileContent);
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex h-full min-h-0 flex-1 min-w-0 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-border bg-page px-5 py-3">
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={handleUpload}
          className="h-7 text-xs"
        >
          <Upload className="w-3.5 h-3.5 mr-1" />
          Upload
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleNewFolder}
          className="h-7 text-xs"
        >
          <FolderPlus className="w-3.5 h-3.5 mr-1" />
          New Folder
        </Button>
        {selectedPaths.size > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDeleteSelected}
            className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" />
            Delete{selectedPaths.size > 1 ? ` (${selectedPaths.size})` : ""}
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* File tree */}
        <div className="w-[260px] border-r border-border bg-page">
          <ScrollArea className="h-full">
            <div className="p-2">
              <div
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer mb-1",
                  focusedDir === ""
                    ? "bg-blue-50 text-blue-700"
                    : "hover:bg-muted",
                  dropTargetDir === "" &&
                    "bg-emerald-50 ring-1 ring-emerald-300",
                )}
                onClick={() => setFocusedDir("")}
                onDragOver={(e) => {
                  if (!draggingPath) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropTargetDir("");
                }}
                onDragLeave={() => {
                  if (dropTargetDir === "") {
                    setDropTargetDir(null);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const sourcePath =
                    draggingPath || e.dataTransfer.getData("text/plain");
                  setDropTargetDir(null);
                  if (!sourcePath) return;
                  handleMove(sourcePath, "");
                }}
              >
                <Folder className="w-3.5 h-3.5 text-mines-gold" />
                <span className="truncate font-medium">Workspace Root</span>
              </div>
              {loadError ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-xs text-red-500">
                    Failed to load workspace
                  </div>
                  <div className="text-[10px] mt-1">{loadError}</div>
                </div>
              ) : displayFiles.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-xs">No files yet.</div>
                  <div className="text-[10px] mt-1">
                    Upload files or chat with the agent to generate content.
                  </div>
                </div>
              ) : (
                <FileTree
                  items={displayFiles}
                  selectedPaths={selectedPaths}
                  onItemClick={handleTreeItemClick}
                  onDelete={handleDelete}
                  onMove={handleMove}
                  focusedDir={focusedDir}
                  expandedDirs={expandedDirs}
                  loadingDirs={loadingDirs}
                  directoryLoadErrors={directoryLoadErrors}
                  onToggleExpand={handleToggleDirectory}
                  isDirectoryPath={(candidate) => directoryPaths.has(candidate)}
                  draggingPath={draggingPath}
                  dropTargetDir={dropTargetDir}
                  onDragStart={setDraggingPath}
                  onDragEnd={() => {
                    setDraggingPath(null);
                    setDropTargetDir(null);
                  }}
                  onDropTargetChange={setDropTargetDir}
                  depth={0}
                />
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Preview pane */}
        <div className="min-h-0 flex-1 flex flex-col min-w-0">
          {selectedFile ? (
            <>
              <div className="flex items-center gap-2 border-b border-border bg-white px-4 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium text-foreground">
                    {selectedFile}
                  </span>
                  {getFileTypeBadge(selectedFile) && (
                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[9px] font-semibold text-blue-700">
                      {getFileTypeBadge(selectedFile)}
                    </span>
                  )}
                </div>
                <div className="ml-auto flex items-center gap-1">
                  {fileMeta && (
                    <span className="mr-2 hidden text-[10px] text-muted-foreground sm:inline">
                      {formatSize(fileMeta.size)} &middot;{" "}
                      {new Date(fileMeta.modified).toLocaleDateString()}
                    </span>
                  )}
                  {isPdf(selectedFile) && (
                    <PdfZoomControls
                      scale={pdfScale}
                      onScaleChange={setPdfScale}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDownload}
                    className="h-7 w-7 p-0"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  {!isRichDoc(selectedFile) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopy}
                      className="h-7 w-7 p-0"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(selectedFile)}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {/* PDF gets its own flex item so overflow-y-auto is on the flex item itself,
                  not on a child — that's the only reliable way to constrain scroll height. */}
              {selectedFile && isPdf(selectedFile) ? (
                <div className="h-full min-h-0 flex-1 overflow-y-auto overflow-x-auto bg-muted/30">
                  <Suspense
                    fallback={
                      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
                        Loading viewer...
                      </div>
                    }
                  >
                    <PdfViewer url={getRawUrl(selectedFile)} scale={pdfScale} />
                  </Suspense>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {selectedFile && isImage(selectedFile) ? (
                    <div className="flex h-full items-center justify-center overflow-auto bg-[#f0f0f0] p-6">
                      <img
                        src={getRawUrl(selectedFile)}
                        alt={selectedFile}
                        className="max-h-full max-w-full rounded object-contain shadow-sm"
                      />
                    </div>
                  ) : selectedFile && isRichDoc(selectedFile) ? (
                    <Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                          Loading viewer...
                        </div>
                      }
                    >
                      {isDocx(selectedFile) ? (
                        <DocxViewer url={getRawUrl(selectedFile)} />
                      ) : isPptx(selectedFile) ? (
                        <PptxViewer url={getRawUrl(selectedFile)} />
                      ) : isHtml(selectedFile) ? (
                        <SandboxedHtmlPreview
                          title={selectedFile}
                          srcDoc={fileContent}
                          className="h-full w-full"
                        />
                      ) : (
                        <XlsxViewer url={getRawUrl(selectedFile)} />
                      )}
                    </Suspense>
                  ) : selectedFile && isMd(selectedFile) ? (
                    fileLoading ? (
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        Loading...
                      </div>
                    ) : (
                      <MarkdownViewer content={fileContent} />
                    )
                  ) : selectedFile && isCode(selectedFile) ? (
                    <CodeViewer
                      content={fileContent}
                      language={getMonacoLanguage(selectedFile)}
                    />
                  ) : (
                    <ScrollArea className="h-full p-4">
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                        {fileContent}
                      </pre>
                    </ScrollArea>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Select a file to preview
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTree({
  items,
  selectedPaths,
  onItemClick,
  onDelete,
  onMove,
  focusedDir,
  expandedDirs,
  loadingDirs,
  directoryLoadErrors,
  onToggleExpand,
  isDirectoryPath,
  draggingPath,
  dropTargetDir,
  onDragStart,
  onDragEnd,
  onDropTargetChange,
  depth,
}: {
  items: WorkspaceTreeNode[];
  selectedPaths: Set<string>;
  onItemClick: (
    item: WorkspaceTreeNode,
    event: MouseEvent<HTMLDivElement>,
  ) => void;
  onDelete: (path: string) => void;
  onMove: (fromPath: string, toDirPath: string) => void;
  focusedDir: string;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  directoryLoadErrors: Record<string, string>;
  onToggleExpand: (path: string) => void;
  isDirectoryPath: (path: string) => boolean;
  draggingPath: string | null;
  dropTargetDir: string | null;
  onDragStart: (path: string) => void;
  onDragEnd: () => void;
  onDropTargetChange: (path: string | null) => void;
  depth: number;
}) {
  return (
    <>
      {items.map((item) => {
        const isExpanded =
          item.type === "directory" && expandedDirs.has(item.path);
        const isLoadingChildren =
          item.type === "directory" && loadingDirs.has(item.path);
        const loadErrorMessage =
          item.type === "directory" ? directoryLoadErrors[item.path] : null;
        return (
          <div key={item.path}>
            <div
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer group",
                selectedPaths.has(item.path)
                  ? "bg-blue-50 text-blue-700"
                  : item.type === "directory" && focusedDir === item.path
                    ? "bg-blue-50 text-blue-700"
                    : "hover:bg-muted",
                item.type === "directory" &&
                  dropTargetDir === item.path &&
                  "bg-emerald-50 ring-1 ring-emerald-300",
              )}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
              onClick={(e) => onItemClick(item, e)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", item.path);
                e.dataTransfer.effectAllowed = "move";
                onDragStart(item.path);
              }}
              onDragEnd={onDragEnd}
              onDragOver={(e) => {
                if (item.type !== "directory" || !draggingPath) return;
                if (draggingPath === item.path) {
                  return;
                }
                if (
                  isDirectoryPath(draggingPath) &&
                  item.path.startsWith(`${draggingPath}/`)
                ) {
                  return;
                }
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                onDropTargetChange(item.path);
              }}
              onDragLeave={() => {
                if (item.type === "directory" && dropTargetDir === item.path) {
                  onDropTargetChange(null);
                }
              }}
              onDrop={(e) => {
                if (item.type !== "directory") return;
                e.preventDefault();
                const sourcePath =
                  draggingPath || e.dataTransfer.getData("text/plain");
                onDropTargetChange(null);
                if (!sourcePath) return;
                if (sourcePath === item.path) return;
                if (
                  isDirectoryPath(sourcePath) &&
                  item.path.startsWith(`${sourcePath}/`)
                )
                  return;
                onMove(sourcePath, item.path);
              }}
            >
              {item.type === "directory" ? (
                <button
                  className="p-0.5 rounded hover:bg-black/5"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand(item.path);
                  }}
                  aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                </button>
              ) : (
                <span className="w-4" />
              )}
              {item.type === "directory" ? (
                <Folder className="w-3.5 h-3.5 text-mines-gold" />
              ) : (
                <File className="w-3.5 h-3.5 text-muted-foreground" />
              )}
              <span className="flex-1 truncate">{item.name}</span>
              {isLoadingChildren ? (
                <span className="text-[10px] text-muted-foreground">
                  Loading...
                </span>
              ) : loadErrorMessage ? (
                <span className="text-[10px] text-red-600">Failed</span>
              ) : null}
              {item.type === "file" && item.size !== undefined && (
                <span className="text-[10px] text-muted-foreground">
                  {item.size < 1024
                    ? `${item.size}B`
                    : `${(item.size / 1024).toFixed(0)}K`}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(item.path);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5"
              >
                <Trash2 className="w-3 h-3 text-muted-foreground hover:text-red-500" />
              </button>
            </div>
            {item.type === "directory" &&
              isExpanded &&
              item.children &&
              item.children.length > 0 && (
                <FileTree
                  items={item.children}
                  selectedPaths={selectedPaths}
                  onItemClick={onItemClick}
                  onDelete={onDelete}
                  onMove={onMove}
                  focusedDir={focusedDir}
                  expandedDirs={expandedDirs}
                  loadingDirs={loadingDirs}
                  directoryLoadErrors={directoryLoadErrors}
                  onToggleExpand={onToggleExpand}
                  isDirectoryPath={isDirectoryPath}
                  draggingPath={draggingPath}
                  dropTargetDir={dropTargetDir}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onDropTargetChange={onDropTargetChange}
                  depth={depth + 1}
                />
              )}
          </div>
        );
      })}
    </>
  );
}
