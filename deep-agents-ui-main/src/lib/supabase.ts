import { createClient } from '@supabase/supabase-js'
import { createBrowserClient } from '@supabase/ssr'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// Browser client with auth session persistence
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey)

// Automatically check for expired session on load and clear if invalid/expired
if (typeof window !== 'undefined') {
  supabase.auth.getSession().then(({ data: { session }, error }) => {
    if (error) {
      console.warn("Supabase auth session error on load, clearing session:", error)
      supabase.auth.signOut().then(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key && key.includes("-auth-token")) {
            localStorage.removeItem(key)
          }
        }
      }).catch(() => {})
    } else if (session) {
      const expiresAt = session.expires_at
      const now = Math.floor(Date.now() / 1000)
      if (expiresAt && expiresAt < now) {
        console.warn("Supabase session expired, signing out...")
        supabase.auth.signOut().then(() => {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key && key.includes("-auth-token")) {
              localStorage.removeItem(key)
            }
          }
        }).catch(() => {})
      }
    }
  }).catch((err) => {
    console.error("Error checking supabase session:", err)
  })
}

// Type helpers
export type AuthUser = {
  id: string
  email: string
  created_at: string
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password })
}

export async function signOut() {
  return supabase.auth.signOut()
}
