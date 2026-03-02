import { loader } from "@monaco-editor/react";
import Editor from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// Configure @monaco-editor/react to use locally bundled monaco-editor (no CDN fetches).
if (typeof window !== "undefined") {
  (window as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: () =>
      new Worker(
        URL.createObjectURL(new Blob([""], { type: "text/javascript" })),
      ),
  };
  loader.config({ monaco });
}

interface CodeViewerProps {
  content: string;
  language: string;
}

export function CodeViewer({ content, language }: CodeViewerProps) {
  return (
    <div className="h-full w-full bg-white">
      <Editor
        height="100%"
        language={language}
        value={content}
        theme="vs"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineHeight: 20,
          wordWrap: "off",
          lineNumbers: "on",
          folding: true,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: { vertical: "visible", horizontal: "visible" },
        }}
      />
    </div>
  );
}
