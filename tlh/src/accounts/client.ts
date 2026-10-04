import { createClient } from '@supabase/supabase-js';
import { accountConfig } from './config.mjs';

export const config = accountConfig(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
export const accountClient = config ? createClient(config.url, config.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
}) : null;
