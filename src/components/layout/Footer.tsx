import { ShieldCheck, Database, Lock } from 'lucide-react'

export function Footer() {
  return (
    <footer className="w-full border-t border-border/60 bg-muted/30 py-8 text-sm text-muted-foreground">
      <div className="container mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6 lg:px-8">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-md bg-emerald-600/10 text-emerald-600 font-bold text-xs">
            A
          </div>
          <span>Atlas Financeiro &copy; {new Date().getFullYear()}</span>
        </div>

        <div className="flex items-center gap-6 text-xs">
          <span className="inline-flex items-center gap-1">
            <Database className="size-3.5 text-emerald-600" />
            Supabase PostgreSQL
          </span>
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3.5 text-emerald-600" />
            Row Level Security (RLS)
          </span>
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3.5 text-emerald-600" />
            OpenCode Governed
          </span>
        </div>
      </div>
    </footer>
  )
}

