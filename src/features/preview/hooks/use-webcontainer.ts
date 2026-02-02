import { useCallback, useEffect, useRef, useState } from "react";
import { WebContainer } from "@webcontainer/api";

import { buildFileTree, getFilePath } from "../utils/file-tree";

import { Id } from "../../../../convex/_generated/dataModel";
import { useFiles } from "@/features/projects/hooks/use-files";

// Singleton WebContainer instance - persists across component remounts
let webcontainerInstance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;
let hasBootedOnce = false;

const getWebContainer = async (): Promise<WebContainer> => {
  // If we already have an instance, return it
  if (webcontainerInstance) {
    return webcontainerInstance;
  }

  // If boot has already been attempted and failed, throw immediately
  // WebContainer only allows one boot() call per page
  if (hasBootedOnce && !webcontainerInstance) {
    throw new Error(
      "WebContainer boot previously failed. Please refresh the page to try again.",
    );
  }

  // Start boot if not already in progress
  if (!bootPromise) {
    hasBootedOnce = true;
    bootPromise = WebContainer.boot({ coep: "credentialless" });
  }

  try {
    webcontainerInstance = await bootPromise;
    return webcontainerInstance;
  } catch (error) {
    // Don't reset bootPromise - WebContainer won't allow another boot anyway
    throw error;
  }
};

interface UseWebContainerProps {
  projectId: Id<"projects">;
  enabled: boolean;
  settings?: {
    installCommand?: string;
    devCommand?: string;
  };
}

export const useWebContainer = ({
  projectId,
  enabled,
  settings,
}: UseWebContainerProps) => {
  const [status, setStatus] = useState<
    "idle" | "booting" | "installing" | "running" | "error"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState("");

  const containerRef = useRef<WebContainer | null>(null);
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const files = useFiles(projectId);

  // Main effect for booting and running the container
  useEffect(() => {
    if (!enabled || !files || files.length === 0 || hasStartedRef.current) {
      return;
    }

    hasStartedRef.current = true;

    // Create abort controller for this run
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const start = async () => {
      try {
        setStatus("booting");
        setError(null);
        setTerminalOutput("");

        const appendOutput = (data: string) => {
          if (!signal.aborted) {
            setTerminalOutput((prev) => prev + data);
          }
        };

        const container = await getWebContainer();
        containerRef.current = container;

        if (signal.aborted) return;

        // Mount files
        const fileTree = buildFileTree(files);
        await container.mount(fileTree);

        if (signal.aborted) return;

        // Listen for server ready
        container.on("server-ready", (_port, url) => {
          if (!signal.aborted) {
            setPreviewUrl(url);
            setStatus("running");
          }
        });

        setStatus("installing");

        // Parse install command (default: npm install)
        const installCmd = settings?.installCommand || "npm install";
        const [installBin, ...installArgs] = installCmd.split(" ");
        appendOutput(`$ ${installCmd}\n`);

        const installProcess = await container.spawn(installBin, installArgs);
        installProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              appendOutput(data);
            },
          }),
        );

        const installExitCode = await installProcess.exit;

        if (signal.aborted) return;

        if (installExitCode !== 0) {
          throw new Error(
            `${installCmd} failed with exit code ${installExitCode}`,
          );
        }

        // Parse dev command (default: npm run dev)
        const devCmd = settings?.devCommand || "npm run dev";
        const [devBin, ...devArgs] = devCmd.split(" ");
        appendOutput(`\n$ ${devCmd}\n`);

        const devProcess = await container.spawn(devBin, devArgs);
        devProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              appendOutput(data);
            },
          }),
        );
      } catch (err) {
        if (!signal.aborted) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setStatus("error");
        }
      }
    };

    start();

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [projectId, enabled, files, settings, restartKey]);

  // Sync file changes (hot-reload)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !files || status !== "running") return;

    const filesMap = new Map(files.map((f) => [f._id, f]));

    for (const file of files) {
      if (file.type !== "file" || file.storageId || !file.content) continue;

      const filePath = getFilePath(file, filesMap);
      container.fs.writeFile(filePath, file.content);
    }
  }, [files, status]);

  // Reset when disabled
  useEffect(() => {
    if (!enabled) {
      hasStartedRef.current = false;
      setStatus("idle");
      setPreviewUrl(null);
      setError(null);
    }
  }, [enabled]);

  // Restart: abort current processes and re-run with existing container
  const restart = useCallback(() => {
    // Abort any running processes
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    // Reset state to trigger a new run
    containerRef.current = null;
    hasStartedRef.current = false;
    setStatus("idle");
    setPreviewUrl(null);
    setError(null);
    setTerminalOutput("");
    setRestartKey((prev) => prev + 1);
  }, []);

  return {
    status,
    previewUrl,
    error,
    terminalOutput,
    restart,
  };
};
