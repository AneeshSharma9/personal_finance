/**
 * A section heading, with its explanation on hover rather than underneath.
 *
 * The descriptions were always on screen and always the same, so they stopped being
 * read — a permanent line of static prose above every table, pushing the numbers
 * down. As a tooltip they are there when wanted and out of the way otherwise.
 *
 * `title` alone would be a mouse-only affordance: it does not appear on keyboard
 * focus, so the description would be unreachable without a pointer. `tabIndex` makes
 * the heading focusable so it also surfaces on focus.
 *
 * The hover is a background, like every other row and control in the app. It was a
 * dotted underline first, which was marking the same thing — but an underline under a
 * heading reads as a rule dividing the header from the table, and it was the one
 * underline left after link underlines were removed.
 *
 * The `ⓘ` is decorative — the focusable element is the heading itself — so it is
 * hidden from assistive tech rather than announced as an empty label.
 *
 * Shared rather than defined per page, so the budgets tables and the buckets page
 * cannot drift into looking like different products. `slot` carries whatever control
 * sits opposite the heading, which is how a header can hold a button without this
 * component knowing what buttons are.
 */
export function SectionHeader({
  title,
  description,
  slot,
}: {
  title: string;
  /** Shown on hover and on keyboard focus. Never rendered inline. */
  description: string;
  /** Optional control on the right, e.g. an "Add bucket" button. */
  slot?: React.ReactNode;
}) {
  return (
    <header className="mb-2 flex items-start justify-between gap-3">
      <h2
        tabIndex={0}
        title={description}
        className="-mx-1.5 min-w-0 cursor-help rounded-md px-1.5 py-0.5 font-medium transition-colors hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:hover:bg-neutral-700 dark:focus-visible:ring-neutral-600"
      >
        {title}
        <span aria-hidden className="ml-1 align-middle text-xs text-neutral-400">
          ⓘ
        </span>
      </h2>
      {slot ? <div className="shrink-0">{slot}</div> : null}
    </header>
  );
}