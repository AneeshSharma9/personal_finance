/**
 * How an account is named on screen.
 *
 * `accounts.name` belongs to Plaid and `syncAccounts` rewrites it on every sync,
 * so the user's own name lives in `accounts.name_override` and is applied at the
 * point of display. The rule lives here rather than being inlined at each call
 * site because "an override wins, absent one Plaid's name shows" has to be the
 * same rule in the accounts list, the net worth breakdown, a transaction's
 * account sub-line and the API, or the same account reads as two accounts.
 *
 * Deliberately not `import "server-only"`: the rename control is a client
 * component and needs the same rule to seed its input and its hint.
 */

/** The subset of an account row needed to decide what to call it. */
export type AccountNameable = {
  /** Plaid's name for the account. */
  name: string;
  /** The user's name for it, or null when they have not set one. */
  nameOverride: string | null;
};

/** The name to show for an account: the user's name if there is one. */
export function accountDisplayName(account: AccountNameable): string {
  return account.nameOverride ?? account.name;
}

/**
 * Whether a name is the user's rather than Plaid's.
 *
 * A `null` override and one that was set and then cleared both mean "not
 * renamed", which is what lets the hint stay off an unrenamed account instead of
 * repeating the name already on screen.
 */
export function isRenamedName(displayName: string, plaidName: string): boolean {
  return displayName !== plaidName;
}

/**
 * Native tooltip naming the real account behind a display name, or null when the
 * two are the same and there is nothing to reveal.
 *
 * Takes the two names rather than a row because the rows that reach a screen are
 * not uniform: an account still carries `name` and `nameOverride`, while the
 * change breakdown has already collapsed them to a display name plus the Plaid
 * one. The wording puts the real name first, since that is what someone hovering
 * is trying to check.
 */
export function accountNameHint(
  displayName: string,
  plaidName: string,
): string | null {
  if (!isRenamedName(displayName, plaidName)) return null;
  return `Renamed. Bank calls it "${plaidName}".`;
}