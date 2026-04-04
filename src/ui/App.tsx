import { useState, useEffect } from 'react';
import { Header } from './pages/components/Header';
import { Home } from './pages/Home';
import { ImageStudio } from './pages/ImageStudio'; 
import { SettingsPanel } from './pages/components/SettingsPanel';
import { Toaster, toast } from 'sonner';

function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeMode, setActiveMode] = useState<'video' | 'image'>('video');

  // --- Auto-Update Listener ---
  useEffect(() => {
    // Check if we are in Electron before trying to require it
    if (window.require) {
      try {
        const { ipcRenderer } = window.require('electron');

        const handleUpdateDownloaded = () => {
          toast.success('Update Ready!', {
            description: 'A new version has been downloaded. Restart now to apply the changes.',
            duration: Infinity, // Keep it visible until they act
            action: {
              label: 'Restart Now',
              onClick: () => ipcRenderer.send('restart-to-update')
            },
          });
        };

        ipcRenderer.on('update-downloaded', handleUpdateDownloaded);

        return () => {
          ipcRenderer.removeAllListeners('update-downloaded');
        };
      } catch (e) {
        console.error("Failed to initialize update listener:", e);
      }
    }
  }, []);

  return (
    <div className="flex flex-col h-screen font-sans bg-background">
      <Toaster theme="dark" position="bottom-right" richColors />
      
      <Header 
        onOpenSettings={() => setIsSettingsOpen(true)} 
        activeMode={activeMode}
        onModeChange={setActiveMode}
      />
      
      <SettingsPanel isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      
      <main className="flex-1 overflow-y-auto">
        {activeMode === 'video' ? (
          <Home />
        ) : (
          <div className="h-full w-full">
            <ImageStudio/>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;