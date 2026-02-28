// src/types.d.ts

export {}; // Ensures this is treated as a module

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        send: (channel: string, data?: any) => void;
        on: (channel: string, func: (event: any, ...args: any[]) => void) => void;
        once: (channel: string, func: (event: any, ...args: any[]) => void) => void;
        removeListener: (channel: string, func: (event: any, ...args: any[]) => void) => void;
        invoke: (channel: string, data?: any) => Promise<any>;
      };
    };
  }
}