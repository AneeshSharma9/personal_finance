"use client";

import { createBrowserClient } from "@supabase/ssr";

import { supabaseAnonKey, supabaseUrl } from "./env-shared";

/**
 * Browser Supabase client for the login form.
 *
 * The anon key is safe to ship - RLS and the email allowlist are what actually
 * protect the data. Never import env.ts (server-only) from client code.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}