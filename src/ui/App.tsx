import { useState } from 'react';
import { Header } from './components/Header';
import { Home } from './pages/Home';
import { SettingsPanel } from './components/SettingsPanel';
import { Toaster } from 'sonner';

function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen font-sans bg-background">
      <Toaster theme="dark" position="bottom-right" />
      
      <Header onOpenSettings={() => setIsSettingsOpen(true)} />
      <SettingsPanel isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      
      <Home />
    </div>
  );
}

export default App;