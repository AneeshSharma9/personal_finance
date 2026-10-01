import { Suspense } from "react";

import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold">Finance</h1>
        <p className="mb-8 text-sm text-neutral-500">
          Sign in to see your accounts.
        </p>

        {/* useSearchParams needs a Suspense boundary in Next.js. */}
        <Suspense fallback={<div className="h-64" />}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}