/**
 * Shared data contract and safe presentation helpers for transaction details.
 *
 * This module is intentionally client-safe: no React, no database, and no
 * server-only imports. A server component can therefore build one serializable
 * object per row and hand it to the client dialog without fetching anything.
 */

export type TransactionDetail = {
  id: number;
  title: string;
  bankDescription: string | null;
  signedAmount: number;
  date: string;
  authorizedDate: string | null;
  pending: boolean;
  excluded: boolean;
  accountName: string | null;
  bucketName: string | null;
  categoryDisplay: string;
  categoryOverride: string | null;
  plaidCategoryPrimary: string | null;
  plaidCategoryDetailed: string | null;
  notes: string | null;
  currency: string | null;
  website: string | null;
  logoUrl: string | null;
};

export type TransactionDetailStatus = "Posted" | "Pending" | "Ignored";

export function transactionDetailStatus(transaction: {
  pending: boolean;
  excluded: boolean;
}): TransactionDetailStatus {
  if (transaction.excluded) return "Ignored";
  if (transaction.pending) return "Pending";
  return "Posted";
}

/**
 * Make a stored website or logo address safely linkable/renderable.
 *
 * Plaid supplies these strings, and a link is not the place to find out that one
 * is `javascript:`, protocol-relative trickery, or otherwise unusable. Hostnames
 * without a scheme get HTTPS, because that is what a bare `venmo.com` means here.
 */
export function externalHttpUrl(
  value: string | null | undefined,
): { href: string; host: string } | null {
  const raw = (value ?? "").trim();
  if (raw.length === 0) return null;

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(raw);
  if (!hasScheme) {
    // Reject this before adding HTTPS: URL happily treats almost any junk as a
    // hostname once a scheme is supplied, including `ht!tp://[invalid`.
    const bareHostname =
      /^(?:[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?\.)+[A-Za-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/;
    if (!bareHostname.test(raw)) return null;
  }

  const candidate = hasScheme
    ? raw
    : `https://${raw.replace(/^\/+/, "")}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.length === 0) return null;
  return { href: parsed.href, host: parsed.hostname.replace(/^www\./, "") };
}

/**
 * A logo has to load, so it additionally has to be HTTPS.
 *
 * An HTTP image on an HTTPS page is blocked as mixed content, which would leave a
 * broken image in the dialog — worse than no logo at all.
 */
export function externalImageUrl(
  value: string | null | undefined,
): { href: string } | null {
  const link = externalHttpUrl(value);
  if (!link) return null;
  return link.href.startsWith("https:") ? { href: link.href } : null;
}
