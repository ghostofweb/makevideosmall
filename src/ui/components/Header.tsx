import { BrainCircuit, Settings } from 'lucide-react';

interface HeaderProps {
  onOpenSettings: () => void;
}

export function Header({ onOpenSettings }: HeaderProps) {
  return (
    <header 
      className="flex justify-between items-center px-8 py-4 bg-surface border-b border-white/5 select-none z-30 relative" 
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3">
        <BrainCircuit className="text-primary w-6 h-6" />
        <h1 className="m-0 text-lg font-semibold tracking-wide text-text-main">Cognitive Encoder</h1>
      </div>
      
      <button 
        onClick={onOpenSettings}
        className="bg-transparent border-none text-text-muted hover:text-text-main cursor-pointer transition-colors"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title="Global Settings"
      >
        <Settings className="w-5 h-5 transition-transform duration-500 hover:rotate-90" />
      </button>
    </header>
  );
}