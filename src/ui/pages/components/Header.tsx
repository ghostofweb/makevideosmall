import { BrainCircuit, Settings, Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from 'next-themes';

interface HeaderProps {
  onOpenSettings: () => void;
}

export function Header({ onOpenSettings }: HeaderProps) {
  const { theme, setTheme } = useTheme();

  return (
    <header
      className="flex justify-between items-center px-6 py-3 bg-background/80 backdrop-blur-md border-b border-border select-none z-30"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2">
        <BrainCircuit className="text-primary w-5 h-5" />
        <h1 className="text-sm font-semibold tracking-wide text-foreground/90">Cognitive Encoder</h1>
      </div>

      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' }}>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="text-muted-foreground hover:text-foreground relative"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          className="text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-4 w-4 transition-transform duration-500 hover:rotate-90" />
        </Button>
      </div>
    </header>
  );
}