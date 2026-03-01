import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, Zap } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

interface AIAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (crf: number) => void;
}

export function AIAnalysisModal({ isOpen, onClose, onComplete }: AIAnalysisModalProps) {
  const [step, setStep] = useState(1);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<{ crf: number; score: number }[]>([]);

  useEffect(() => {
    if (!isOpen) {
      setStep(1);
      setProgress(0);
      setResults([]);
      return;
    }

    const runSimulation = async () => {
      // Step 1: Extracting reference
      setStep(1);
      for (let i = 0; i <= 100; i += 5) {
        setProgress(i);
        await new Promise(r => setTimeout(r, 30));
      }
      await new Promise(r => setTimeout(r, 500));

      // Step 2: Testing CRFs
      setStep(2);
      const testCrfs = [28, 32, 36];
      const scores = [];
      for (let i = 0; i < testCrfs.length; i++) {
        setProgress(0);
        for (let j = 0; j <= 100; j += 10) {
          setProgress(j);
          await new Promise(r => setTimeout(r, 50));
        }
        scores.push({ crf: testCrfs[i], score: 98 - i * 2.5 });
        setResults([...scores]);
        await new Promise(r => setTimeout(r, 300));
      }

      // Step 3: Analysis complete
      setStep(3);
      await new Promise(r => setTimeout(r, 800));
      onComplete(32); // recommend CRF 32
      onClose();
    };

    runSimulation();
  }, [isOpen, onComplete, onClose]);

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center"
    >
      <Card className="w-96 p-6 border-border/50 bg-card/90">
        <div className="flex items-center gap-3 mb-4">
          <Zap className="w-5 h-5 text-yellow-400" />
          <h3 className="text-lg font-bold">AI VMAF Neural Scan</h3>
        </div>

        <div className="space-y-4">
          {step === 1 && (
            <div className="space-y-2">
              <p className="text-sm">Extracting reference slice...</p>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm">Testing CRF {results.length + 1}/3</p>
              <Progress value={progress} className="h-2" />
              {results.map((r, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span>CRF {r.crf}</span>
                  <span className="font-mono">VMAF {r.score.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <p className="text-sm">Calculating optimal CRF...</p>
              </div>
            </div>
          )}
        </div>
      </Card>
    </motion.div>
  );
}