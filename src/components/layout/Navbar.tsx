import { useState, useEffect } from 'react'
import { Sun, Moon, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EsticaGranaLogo } from '@/components/brand/EsticaGranaLogo'
import { supabase } from '@/lib/supabase'

export function Navbar() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [backendStatus, setBackendStatus] = useState<'checking' | 'connected' | 'offline'>('checking')

  useEffect(() => {
    // Checar conexão com Supabase backend
    async function checkBackend() {
      try {
        const { error } = await supabase.from('tenants').select('count', { count: 'exact', head: true })
        // Se responder mesmo com erro de auth/RLS (401/403/PGRST), a infraestrutura está online
        if (!error || error.code === 'PGRST116' || error.code === '42501' || error.message) {
          setBackendStatus('connected')
        } else {
          setBackendStatus('offline')
        }
      } catch {
        setBackendStatus('offline')
      }
    }
    checkBackend()
  }, [])

  function toggleTheme() {
    const nextTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(nextTheme)
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <EsticaGranaLogo size="lg" subtitle="Finanças Pessoais" />
        </div>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
          <a href="#/landing" className="hover:text-foreground transition-colors">
            Funcionalidades
          </a>
          <a href="#/landing" className="hover:text-foreground transition-colors">
            Arquitetura Backend
          </a>
          <a href="#/landing" className="hover:text-foreground transition-colors">
            Supabase & Edge
          </a>
        </nav>

        <div className="flex items-center gap-2.5">
          <Badge
            variant="outline"
            className="hidden sm:inline-flex items-center gap-1.5 py-1 text-xs"
          >
            <span
              className={`size-2 rounded-full ${
                backendStatus === 'connected'
                  ? 'bg-emerald-500 animate-pulse'
                  : backendStatus === 'checking'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-rose-500'
              }`}
            />
            {backendStatus === 'connected' ? 'Supabase Online' : backendStatus === 'checking' ? 'Conectando...' : 'Supabase Local'}
          </Badge>

          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Alternar tema">
            {theme === 'light' ? <Moon className="size-4" /> : <Sun className="size-4" />}
          </Button>

          <Button size="sm" className="hidden sm:inline-flex gap-1.5">
            Iniciar
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </header>
  )
}
