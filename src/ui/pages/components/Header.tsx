// @ts-nocheck
import { Settings, Sun, Moon, Video, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from 'next-themes';

// Import both versions of the logo
import logoWhite from '../../../../public/logo-white.png';
import logoDark from '../../../../public/logo.png';

interface HeaderProps {
  onOpenSettings: () => void;
  activeMode: 'video' | 'image';
  onModeChange: (mode: 'video' | 'image') => void;
}

export function Header({ onOpenSettings, activeMode, onModeChange }: HeaderProps) {
  // Use resolvedTheme to correctly handle 'system' mode detection
  const { theme, setTheme, resolvedTheme } = useTheme();

  // Determine which logo to display based on the active theme
  const activeLogo = resolvedTheme === 'dark' ? logoWhite : logoDark;

  return (
    <header
      className="flex justify-between items-center px-6 pb-3 pt-10 bg-background/80 backdrop-blur-md border-b border-border select-none z-30"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      {/* LEFT: Logo & Brand */}
      <div className="flex items-center gap-2 w-1/3">
        <img 
          src={activeLogo} 
          alt="Make Video Small Logo" 
          className="w-10 h-10 object-contain transition-opacity duration-300" 
        />
        <h1 className="text-sm font-semibold tracking-wide text-foreground/90">Make Video Small</h1>
      </div>

      {/* CENTER: The Studio Toggle */}
      <div 
        className="flex items-center bg-secondary/50 p-1 rounded-full border border-border/50 shadow-inner"
        style={{ WebkitAppRegion: 'no-drag' } as any}
      >
        <button
          onClick={() => onModeChange('video')}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-300 ${
            activeMode === 'video' 
              ? 'bg-background text-foreground shadow-sm' 
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Video className="w-3.5 h-3.5" />
          Video
        </button>
        <button
          onClick={() => onModeChange('image')}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-300 ${
            activeMode === 'image' 
              ? 'bg-background text-foreground shadow-sm' 
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <ImageIcon className="w-3.5 h-3.5" />
          Image
        </button>
      </div>

      {/* RIGHT: Settings & Theme */}
      <div className="flex items-center gap-2 w-1/3 justify-end" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="text-muted-foreground hover:text-foreground relative rounded-full"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          className="text-muted-foreground hover:text-foreground rounded-full"
        >
          <Settings className="h-4 w-4 transition-transform duration-500 hover:rotate-90" />
        </Button>
      </div>
    </header>
  );
}