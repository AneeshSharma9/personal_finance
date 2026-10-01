"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Manual "Refresh" button: triggers POST /api/sync. */
export function SyncButton({
  label = "Refresh",
  full = false,
}: {
  label?: string;
  full?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<{
    phase: "idle" | "working" | "done" | "error";
    message?: string;
  }>({ phase: "idle" });

  async function handleSync() {
    setState({ phase: "working" });

    try {
      const response = await fetch("/api/sync", { method: "POST" });
      const data = (await response.json()) as {
        error?: string;
        results?: { ok: boolean; added: number; error?: string }[];
      };

      if (!response.ok) {
        setState({ phase: "error", message: data.error ?? "Sync failed." });
        return;
      }

      const failed = (data.results ?? []).filter((r) => !r.ok);
      const added = (data.results ?? []).reduce((sum, r) => sum + r.added, 0);

      if (failed.length > 0) {
        setState({
          phase: "error",
          message: `${failed.length} of ${data.results?.length} items failed: ${
            failed[0]?.error ?? "unknown error"
          }`,
        });
        return;
      }

      setState({
        phase: "done",
        message:
          added > 0
            ? `Synced ${added} new transaction${added === 1 ? "" : "s"}.`
            : "Everything is up to date.",
      });
      router.refresh();
    } catch (error) {
      setState({
        phase: "error",
        message:
          error instanceof Error ? error.message : "Sync failed.",
      });
    }
  }

  return (
    <div className={full ? "flex flex-col gap-2" : "inline-flex flex-col gap-1"}>
      <button
        type="button"
        onClick={handleSync}
        disabled={state.phase === "working"}
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
        
      >
        {state.phase === "working" ? "Syncing..." : label}
      </button>

      {state.message ? (
        <p
          role="status"
          className={`text-xs ${
            state.phase === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-neutral-500"
          }`}
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}