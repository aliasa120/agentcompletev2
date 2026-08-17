import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export const oauthStore = {
  async saveCode(code: string, userId: string, email: string) {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes
    const { error } = await supabase
      .from('oauth_tokens')
      .insert({
        type: 'code',
        token_value: code,
        user_id: userId,
        email: email,
        expires_at: expiresAt
      });
    if (error) {
      console.error('Error saving OAuth code to Supabase:', error);
    }
  },

  async validateCode(code: string): Promise<{ userId: string; email: string } | null> {
    // 1. Fetch code details
    const { data, error } = await supabase
      .from('oauth_tokens')
      .select('user_id, email, expires_at')
      .eq('type', 'code')
      .eq('token_value', code)
      .maybeSingle();

    if (error || !data) return null;

    // 2. Delete code (single-use)
    await supabase
      .from('oauth_tokens')
      .delete()
      .eq('type', 'code')
      .eq('token_value', code);

    // 3. Check if expired
    if (new Date(data.expires_at).getTime() < Date.now()) {
      return null;
    }

    return { userId: data.user_id, email: data.email };
  },

  async saveToken(token: string, userId: string, email: string) {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
    const { error } = await supabase
      .from('oauth_tokens')
      .insert({
        type: 'token',
        token_value: token,
        user_id: userId,
        email: email,
        expires_at: expiresAt
      });
    if (error) {
      console.error('Error saving OAuth token to Supabase:', error);
    }
  },

  async validateToken(token: string): Promise<{ userId: string; email: string } | null> {
    // Fetch token details
    const { data, error } = await supabase
      .from('oauth_tokens')
      .select('user_id, email, expires_at')
      .eq('type', 'token')
      .eq('token_value', token)
      .maybeSingle();

    if (error || !data) return null;

    // Check if expired
    if (new Date(data.expires_at).getTime() < Date.now()) {
      // Delete expired token
      await supabase
        .from('oauth_tokens')
        .delete()
        .eq('type', 'token')
        .eq('token_value', token);
      return null;
    }

    return { userId: data.user_id, email: data.email };
  }
};
