import { app, BrowserWindow, protocol, net, nativeTheme } from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { isDev } from "./util.js"; // Importing your utility check
import { registerAllIPCs } from "./api/index.js";

// 1. ESM Environment Setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2. Privilege local scheme for video streaming
protocol.registerSchemesAsPrivileged([
  { 
    scheme: 'local', 
    privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } 
  }
]);

app.on("ready", () => {
  // 3. Handle Local Protocol for Asset Loading
  protocol.handle('local', (request) => {
    let filePath = request.url.replace(/^local:\/\/\//i, '');
    filePath = decodeURIComponent(filePath);
    return net.fetch(pathToFileURL(filePath).href);
  });

  // 4. Boot Backend APIs (FFmpeg, Python, System Hooks)
  registerAllIPCs();

  const projectRoot = app.getAppPath();

  // 5. Dynamic Theme Icon Logic
  // Checks OS theme and grabs the correct PNG from resources (Prod) or public (Dev)
  const getIconPath = () => {
    const isDark = nativeTheme.shouldUseDarkColors;
    const fileName = isDark ? 'logo-white.png' : 'logo.png';
    
    return app.isPackaged 
      ? path.join(process.resourcesPath, fileName) 
      : path.join(__dirname, '../public', fileName);
  };

  // 6. Main Window Configuration
  const mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1024,
    minHeight: 700,
    title: "VideoBake Studio",
    icon: getIconPath(), // Initialize with the correct OS theme icon
    backgroundColor: '#09090b', // Prevents white flash
    autoHideMenuBar: true,
    
    // Seamless native frame with hidden title bar
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#09090b',
      symbolColor: '#ffffff',
      height: 32
    },

    show: false, // Don't show until React is painted

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false // Necessary for local file access
    }
  });

  // 7. Listen for OS Theme Changes (Swaps icon dynamically while app is open!)
  nativeTheme.on('updated', () => {
    mainWindow.setIcon(getIconPath());
  });

  // 8. Graceful Launch Logic
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 9. Environment-Specific Loading
  if (isDev() === "development") {
    mainWindow.loadURL("http://localhost:5123/");
  } else {
    // Loads from the build folder in production
    mainWindow.loadFile(path.join(projectRoot, 'dist-react', 'index.html'));
  }
});