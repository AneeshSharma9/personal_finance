"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { accountNameHint, isRenamedName } from "@/lib/account-name";

/**
 * Naming an account: showing what the bank calls it, and changing it.
 *
 * Two controls, because they solve two different problems.
 *
 * `TapToRevealName` is for reading. A nickname replaces the bank's name
 * everywhere, and the bank's name is still the answer to "which account is this
 * actually" — so it stays reachable rather than lost. `title` handles pointer
 * users, but a touch device has no hover, so where a tap is free (a row that is
 * not a link) the name expands instead. Where the row *is* a link a tap navigates
 * and no control can be nested inside it, so those surfaces use the tooltip and
 * the account's own page.
 *
 * `AccountRenameEditor` is for writing. It posts to PATCH /api/accounts/[id],
 * which writes `name_override` — not `name`, because `syncAccounts` rewrites
 * `name` from Plaid on every sync and the rename would not survive the first one.
 */

/** Longest nickname the editor will accept; the route enforces the same cap. */
const MAX_NICKNAME_LENGTH = 80;

/**
 * An account name that expands to show the bank's name on tap.
 *
 * Renders plain text when the account has not been renamed. A button around
 * every account name on a page would put a tab stop and a focus ring on dozens
 * of rows that have nothing to reveal, which is worse than not offering it.
 */
export function TapToRevealName({
  name,
  plaidName,
  className,
}: {
  /** What to show: the user's name for the account if they set one. */
  name: string;
  /** The bank's name for it, revealed on tap. */
  plaidName: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  if (!isRenamedName(name, plaidName)) {
    return <span className={className}>{name}</span>;
  }

  return (
    <span className={className}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        // The tooltip is the hover answer; the tap is the touch answer to the
        // same question. Neither replaces the account page, which says it outright.
        title={accountNameHint(name, plaidName) ?? undefined}
        className="max-w-full truncate rounded px-1 py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
      >
        {name}
      </button>
      {open ? (
        <span className="mt-0.5 block text-xs text-neutral-500">
          Bank calls this {plaidName}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Rename one account, or put its bank name back.
 *
 * Save is an explicit button rather than save-on-blur because this name is not
 * cosmetic: it is the label every list, chart and transaction sub-line in the
 * app keys off, and a blur-save would rename an account from a stray click
 * somewhere else on the page. Enter saves and Escape reverts, so it is still
 * usable without a mouse.
 */
export function AccountRenameEditor({
  accountId,
  name,
  plaidName,
}: {
  accountId: number;
  /** The account's current display name. */
  name: string;
  /** The bank's name for it - what the field reverts to on reset. */
  plaidName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  const renamed = isRenamedName(name, plaidName);

  function startEditing() {
    setDraft(name);
    setError(null);
    setEditing(true);
  }

  async function save(next: string) {
    setError(null);
    setDraft(next);

    try {
      const response = await fetch(`/api/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // An empty field is how the reset is expressed; the route turns it into
        // a null override rather than an empty name.
        body: JSON.stringify({ nameOverride: next }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? "Could not rename this account.");
        return;
      }

      setEditing(false);
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-neutral-500">
          {renamed
            ? `Shown as "${name}" everywhere. The bank calls this ${plaidName}.`
            : "Shown as the bank's name. Give it one of your own if you would rather."}
        </p>
        <button
          type="button"
          onClick={startEditing}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700"
        >
          {renamed ? "Rename" : "Nickname this"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/*
        A form rather than a bare input so Enter submits natively; `noValidate`
        because the length cap is stated in the helper text below instead of being
        enforced by a browser tooltip that only half the users will read.
      */}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft);
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          autoFocus
          value={draft}
          maxLength={MAX_NICKNAME_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
          aria-label="Nickname for this account"
          placeholder={plaidName}
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-700 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700"
        >
          Cancel
        </button>
      </form>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <p className="text-xs text-neutral-500">
        {renamed ? (
          <>
            Up to {MAX_NICKNAME_LENGTH} characters. Leave it empty to go back to{" "}
            {plaidName}.
          </>
        ) : (
          <>Up to {MAX_NICKNAME_LENGTH} characters. Leave it empty to keep {plaidName}.</>
        )}
      </p>
    </div>
  );
}