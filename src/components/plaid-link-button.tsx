"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PlaidLinkOnSuccess,
  usePlaidLink,
  type PlaidLinkOptions,
} from "react-plaid-link";

import type { ItemStatus } from "@/db/schema";

type LinkState =
  | { phase: "idle" }
  | { phase: "loading-token" }
  | { phase: "exchanging" }
  | { phase: "error"; message: string };

/**
 * Plaid Link button.
 *
 * Flow (PLANNED_ARCHITECTURE.md 5.1):
 *   1. POST /api/plaid/link-token  -> a Link token
 *   2. Open Plaid Link with that token
 *   3. On success Link hands back a public_token
 *   4. POST /api/plaid/exchange   -> we swap it for a durable access_token
 *
 * Step 4 is the one that creates the Item, so it must run to completion; the
 * public_token is never persisted anywhere in the browser.
 */
export function PlaidLinkButton({
  /** When set, the token is an update-mode token for this Item (no new slot). */
  itemId,
  buttonLabel = "Link an institution",
  className,
  variant = "solid",
}: {
  itemId?: number;
  buttonLabel?: string;
  className?: string;
  /** `subtle` sits inline in a list of controls instead of acting as the CTA. */
  variant?: "solid" | "subtle";
}) {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<LinkState>({ phase: "idle" });

  const createToken = useCallback(async (): Promise<string> => {
    setState({ phase: "loading-token" });

    const response = await fetch("/api/plaid/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(itemId ? { body: JSON.stringify({ itemId }) } : {}),
    });

    const data = (await response.json()) as {
      linkToken?: string;
      error?: string;
    };

    if (!response.ok || !data.linkToken) {
      throw new Error(data.error ?? "Could not start Plaid Link.");
    }
    return data.linkToken;
  }, [itemId]);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token, metadata) => {
      /*
       * Update mode hands back no public_token: the existing access_token is
       * reused, and the user has only granted access to another account. There
       * is nothing to exchange, so calling /api/plaid/exchange would fail its
       * own validation with "public_token is required".
       *
       * Instead pull /accounts/get so the newly shared card actually lands in
       * the database, then reload as the new-mode path does.
       */
      if (itemId) {
        setState({ phase: "exchanging" });
        const response = await fetch("/api/plaid/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId }),
        });
        if (!response.ok) {
          const data = (await response.json()) as { error?: string };
          setState({
            phase: "error",
            message: data.error ?? "Could not refresh that institution.",
          });
          return;
        }
        window.location.reload();
        return;
      }

      setState({ phase: "exchanging" });

      try {
        const response = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            public_token,
            institution: metadata.institution
              ? {
                  name: metadata.institution.name,
                  institution_id: metadata.institution.institution_id,
                }
              : undefined,
          }),
        });

        const data = (await response.json()) as { error?: string };
        if (!response.ok) {
          setState({
            phase: "error",
            message: data.error ?? "Could not save the linked account.",
          });
          return;
        }

        // Full reload so the new Item's accounts and balances are read
        // server-side.
        window.location.reload();
      } catch (error) {
        setState({
          phase: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not save the account.",
        });
      }
    },
    // itemId selects the update-mode branch above, so it is a real dependency.
    [itemId],
  );

  const config: PlaidLinkOptions = {
    token,
    onSuccess,
    // Clear the token when Link closes so the effect below does not reopen it,
    // and so the next click mints a fresh one.
    onExit: () => setToken(null),
  };
  const { open, ready } = usePlaidLink(config);

  // usePlaidLink flips `ready` to true once it holds a usable token. Opening
  // inside the click handler would capture a stale `open`, so the effect reacts
  // to that transition instead.
  useEffect(() => {
    if (!ready) return;
    open();
  }, [ready, open]);

  /**
   * Fetch the Link token when the user asks for it, rather than on mount.
   *
   * Minting it up front would fire a Plaid call on every render of the
   * accounts page and create tokens nobody uses.
   */
  async function handleClick() {
    let linkToken: string;
    try {
      linkToken = await createToken();
    } catch (error) {
      setState({
        phase: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not start Plaid Link.",
      });
      return;
    }

    // The effect above opens Link as soon as the hook reports ready.
    setToken(linkToken);
  }

  const label =
    state.phase === "loading-token"
      ? "Preparing..."
      : state.phase === "exchanging"
        ? "Saving..."
        : buttonLabel;

  /*
   * Update mode is used for two different jobs: repairing a login, and adding a
   * newly issued account. Both return no public_token, so the button says which
   * it is rather than showing a bare "Link an account".
   */

  return (
    <div className={className}>
      {/*
        Sized to match SyncButton, which sits next to it on /accounts. text-sm +
        py-2 give the same 36px content box; the transparent border adds the 1px
        edge SyncButton gets from `border`, so the two are identical in height
        while keeping the solid fill.
      */}
      <button
        type="button"
        onClick={handleClick}
        disabled={state.phase === "exchanging"}
        className={
          variant === "subtle"
            ? "rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
            : "rounded-md border border-transparent bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-300"
        }
      >
        {label}
      </button>

      {state.phase === "error" ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Re-auth button for an Item that needs a login again.
 *
 * Renders nothing unless the Item actually needs it, so it can sit
 * unconditionally in a list row.
 */
export function ReauthButton({
  itemId,
  status,
}: {
  itemId: number;
  status: ItemStatus;
}) {
  if (status !== "login_required" && status !== "requires_update") {
    return null;
  }

  return <PlaidLinkButton itemId={itemId} buttonLabel="Fix login" />;
}

/**
 * Grant Plaid access to another account at an institution already linked.
 *
 * Uses Link **update mode**, so no new Item is created and no Trial-plan slot is
 * spent. That matters because `/item/remove` does not free a slot on the Trial
 * plan: unlinking and re-linking to pick up a new card would cost a permanent
 * slot out of ten for an identical connection.
 *
 * Sends `update.account_selection_enabled`, which is what makes Plaid show the
 * account picker. Without it, update mode can only repair a login.
 *
 * US/CA only - Plaid has no update-mode account selection in the UK/EU.
 */
export function AddAccountButton({ itemId }: { itemId: number }) {
  return (
    <PlaidLinkButton
      itemId={itemId}
      buttonLabel="Add an account"
      variant="subtle"
    />
  );
}