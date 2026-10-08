import { accountNameHint } from "@/lib/account-name";

/**
 * An account's name as shown to the user, with the bank's name one hover away.
 *
 * A server component with no state, because every surface that shows an account
 * name needs the same thing and only some of them can afford an interactive
 * control: on the accounts list the whole row is a link, so a button nested in it
 * would be both invalid and a misclick (see the note there). `title` covers
 * pointer users everywhere, and the surfaces that cannot carry it say so
 * themselves — the account's own page lists the bank name as a detail, and
 * `AccountChangeList` falls back to its own row tooltip on the linked variant.
 *
 * Takes the two names already resolved rather than an account row because the
 * rows are not uniform: an account still carries `name` and `name_override`,
 * while the change breakdown has collapsed them to a display name plus the
 * bank's. Callers with a full row use `accountDisplayName`.
 */
export function AccountName({
  name,
  plaidName,
  className,
}: {
  /** What to show: the user's name for the account if they set one. */
  name: string;
  /** The bank's name for it, revealed on hover. */
  plaidName: string;
  className?: string;
}) {
  const hint = accountNameHint(name, plaidName);

  return (
    <span className={className} title={hint ?? undefined}>
      {name}
    </span>
  );
}