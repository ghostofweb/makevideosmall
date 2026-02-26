import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { type QueuedFile } from '../../types'; // adjust path if needed

interface VideoDNAPanelProps {
  file: QueuedFile;
  onClose: () => void;
}

// Mock DNA data – in a real app this would come from the file analysis
const mockDNA = {
  resolution: '1920x1080',
  fps: 23.976,
  bitDepth: 10,
  colorSpace: 'yuv420p10le',
  isHDR: false,
  grainLevel: 8,
  noiseProfile: 'Medium (Standard Noise)',
  bpp: 0.12,
  crop: 'crop=1920:800:0:140',
  estimatedSavings: 62.5,
};

export function VideoDNAPanel({ file, onClose }: VideoDNAPanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="absolute right-0 top-0 bottom-0 w-80 bg-card/90 backdrop-blur-md border-l border-border shadow-2xl z-30 p-4 overflow-y-auto"
    >
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-bold text-foreground">🧬 Video DNA</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">File</p>
          <p className="text-sm font-medium truncate">{file.name}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Resolution</p>
            <p className="text-sm font-mono">{mockDNA.resolution}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">FPS</p>
            <p className="text-sm font-mono">{mockDNA.fps}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Bit Depth</p>
            <p className="text-sm font-mono">{mockDNA.bitDepth}-bit</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">HDR</p>
            <Badge variant={mockDNA.isHDR ? 'default' : 'secondary'} className="text-xs">
              {mockDNA.isHDR ? 'Yes' : 'No'}
            </Badge>
          </div>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">Grain Profile</p>
          <p className="text-sm">{mockDNA.noiseProfile}</p>
          <p className="text-xs text-muted-foreground mt-1">Grain Level: {mockDNA.grainLevel}</p>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">Smart Crop</p>
          <code className="text-xs bg-background/50 p-1 rounded block">{mockDNA.crop}</code>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">Estimated Savings</p>
          <p className="text-lg font-bold text-green-400">{mockDNA.estimatedSavings}%</p>
        </div>

        <Button className="w-full" size="sm">
          Apply AI Treatment Plan
        </Button>
      </div>
    </motion.div>
  );
}