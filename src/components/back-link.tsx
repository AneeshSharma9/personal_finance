import Link from "next/link";

/**
 * A "back to somewhere" link, styled so it cannot be mistaken for an action.
 *
 * Every other button on the site is a rectangle: `rounded-md`, either filled
 * (`bg-neutral-900`) or outlined (`border-neutral-300`), sized `px-2`–`px-4`. A back
 * link is neither — it does not do anything on this page, it just undoes the
 * navigation you just did. So it is a **pill**: borderless, muted, one step smaller,
 * with a leading arrow. Different shape rather than a different shade, because a
 * back link sits directly above a page full of action buttons and two greys side by
 * side would be read as "another button".
 *
 * It replaced an underlined text link, which had the opposite problem: it looked
 * like body text that happened to be clickable, and underlines on hover made it
 * shift under the pointer.
 *
 * `focus-visible` keeps the ring, since this is reachable by keyboard.
 */
export function BackLink({
  href,
  children,
}: {
  href: string;
  /** Label after the arrow, e.g. "Budgets". */
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:outline-none dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:focus-visible:ring-neutral-600"
    >
      {/*
        A real arrow character rather than an icon component, so it inherits the
        label's size and colour and costs nothing. The small gap on hover nudges it
        left, which is the conventional "this goes back" tell.
      */}
      <span
        aria-hidden
        className="transition-transform group-hover:-translate-x-0.5"
      >
        {"\u2190"}
      </span>
      {children}
    </Link>
  );
}