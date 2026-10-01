import type { Metadata } from "next";

import { AppShell } from "@/components/app-shell";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Finance",
};

/**
 * Shell for every signed-in page.
 *
 * Requiring the user here means no page below can render without a session, and
 * `requireUser` redirects to /login when there isn't one.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();

  return (
    <AppShell email={user.email} signOut={<SignOutButton />}>
      {children}
    </AppShell>
  );
}