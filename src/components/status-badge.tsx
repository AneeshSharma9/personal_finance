import type { ItemStatus } from "@/db/schema";

const STYLES: Record<ItemStatus, string> = {
  healthy: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  login_required:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  requires_update:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  pending_expiration:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  user_locked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  item_locked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  revoked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  pending_disconnect:
    "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

const LABELS: Record<ItemStatus, string> = {
  healthy: "Healthy",
  login_required: "Login required",
  requires_update: "Re-auth needed",
  pending_expiration: "Expiring soon",
  user_locked: "Locked",
  item_locked: "Locked",
  revoked: "Revoked",
  error: "Error",
  pending_disconnect: "Disconnecting",
};

export function StatusBadge({ status }: { status: ItemStatus }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[status]}`}
    >
      {LABELS[status]}
    </span>
  );
}