"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  externalHttpUrl,
  externalImageUrl,
  transactionDetailStatus,
  type TransactionDetail,
} from "@/lib/transaction-details";
import { formatCurrency, formatDate, humanizeCategory } from "@/lib/format";

/**
 * Read-only detail view for one already-loaded transaction.
 *
 * Each list passes its row through as data, so opening the dialog needs no
 * additional request and cannot change server state. That boundary is deliberate:
 * transaction rows are editable elsewhere through category, bucket, notes, and
 * loan actions, while this dialog is only for inspecting what was stored.
 */
export function TransactionDetailsButton({
  transaction,
  buttonClassName,
  titleClassName,
  footer,
}: {
  transaction: TransactionDetail;
  buttonClassName?: string;
  titleClassName?: string;
  /**
   * Optional row action rendered inside the dialog.
   *
   * The dialog itself remains a detail view: callers can relocate an existing
   * row control here, but it is not a general editing surface.
   */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;

    const trigger = triggerRef.current;
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open, close]);

  const status = transactionDetailStatus(transaction);
  const logo = externalImageUrl(transaction.logoUrl);
  const website = externalHttpUrl(transaction.website);
  const titleId = `transaction-details-title-${transaction.id}`;
  const bankDescription = transaction.bankDescription?.trim() || null;
  const notes = transaction.notes?.trim() || null;
  const showStoredDescription =
    bankDescription !== null && bankDescription !== transaction.title;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-label={`View details for ${transaction.title}`}
        title={`View details for ${transaction.title}`}
        onClick={() => setOpen(true)}
        className={
          buttonClassName ??
          "block w-full truncate text-left font-medium transition-colors hover:text-neutral-900 dark:hover:text-neutral-100"
        }
      >
        <span className={titleClassName ?? "block truncate"}>
          {transaction.title}
        </span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={(event) => {
            // A press that starts on the backdrop and ends there dismisses. A
            // drag that began inside the panel must not close the dialog.
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-4 shadow-xl outline-none dark:bg-neutral-900"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                {logo ? (
                  <>
                    {/* next/image would require a remote-domain allowlist for Plaid logos. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                    src={logo.href}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-10 w-10 shrink-0 rounded-full bg-white object-contain p-1"
                  />
                  </>
                ) : null}
                <div className="min-w-0">
                  <h2
                    id={titleId}
                    className="text-lg font-semibold break-words"
                  >
                    {transaction.title}
                  </h2>
                  <p className="text-sm text-neutral-500">
                    {formatDate(transaction.date)} · {status}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close transaction details"
                className="shrink-0 rounded-md px-2 py-1 text-xl leading-none text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
              >
                ×
              </button>
            </div>

            <p
              className={`mt-3 text-xl font-semibold tabular-nums ${
                transaction.signedAmount < 0
                  ? ""
                  : "text-green-700 dark:text-green-400"
              }`}
            >
              {formatCurrency(transaction.signedAmount, { showSign: true })}
            </p>

            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-xs text-neutral-500">
                  Description from Plaid
                </dt>
                <dd className="mt-0.5 break-words">
                  {showStoredDescription ? bankDescription : transaction.title}
                </dd>
              </div>

              <div>
                <dt className="text-xs text-neutral-500">Category</dt>
                <dd className="mt-0.5">
                  {humanizeCategory(transaction.categoryDisplay)}
                </dd>
                {transaction.categoryOverride &&
                transaction.categoryOverride !== transaction.categoryDisplay ? (
                  <dd className="mt-0.5 text-xs text-neutral-500">
                    Your override:{" "}
                    {humanizeCategory(transaction.categoryOverride)}
                  </dd>
                ) : null}
                {transaction.plaidCategoryPrimary ||
                transaction.plaidCategoryDetailed ? (
                  <dd className="mt-0.5 text-xs text-neutral-500">
                    Plaid:{" "}
                    {[
                      transaction.plaidCategoryPrimary,
                      transaction.plaidCategoryDetailed &&
                      transaction.plaidCategoryDetailed !==
                        transaction.plaidCategoryPrimary
                        ? transaction.plaidCategoryDetailed
                        : null,
                    ]
                      .filter((value): value is string => Boolean(value))
                      .map(humanizeCategory)
                      .join(" › ") || "Not provided"}
                  </dd>
                ) : null}
              </div>

              {transaction.accountName ? (
                <div>
                  <dt className="text-xs text-neutral-500">Account</dt>
                  <dd className="mt-0.5">{transaction.accountName}</dd>
                </div>
              ) : null}

              {transaction.bucketName ? (
                <div>
                  <dt className="text-xs text-neutral-500">Budget</dt>
                  <dd className="mt-0.5">{transaction.bucketName}</dd>
                </div>
              ) : null}

              {transaction.authorizedDate &&
              transaction.authorizedDate !== transaction.date ? (
                <div>
                  <dt className="text-xs text-neutral-500">Authorized</dt>
                  <dd className="mt-0.5">
                    {formatDate(transaction.authorizedDate)}
                  </dd>
                </div>
              ) : null}

              {notes ? (
                <div>
                  <dt className="text-xs text-neutral-500">Notes</dt>
                  <dd className="mt-0.5 break-words whitespace-pre-wrap">
                    {notes}
                  </dd>
                </div>
              ) : null}

              {transaction.currency ? (
                <div>
                  <dt className="text-xs text-neutral-500">Currency</dt>
                  <dd className="mt-0.5">{transaction.currency}</dd>
                </div>
              ) : null}

              {website ? (
                <div>
                  <dt className="text-xs text-neutral-500">Merchant online</dt>
                  <dd className="mt-0.5">
                    <a
                      href={website.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-blue-700 hover:underline dark:text-blue-400"
                    >
                      {website.host}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
            {footer ? (
              <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                {footer}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
