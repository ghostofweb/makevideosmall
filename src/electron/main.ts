import { app, BrowserWindow, protocol, net, nativeTheme, ipcMain } from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { isDev } from "./util.js";
import { registerAllIPCs } from "./api/index.js";
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

protocol.registerSchemesAsPrivileged([
  { 
    scheme: 'local', 
    privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } 
  }
]);

app.on("ready", () => {
  protocol.handle('local', (request) => {
    let filePath = request.url.replace(/^local:\/\/\//i, '');
    filePath = decodeURIComponent(filePath);
    return net.fetch(pathToFileURL(filePath).href);
  });
  if (!isDev()) {
    autoUpdater.checkForUpdatesAndNotify();
  }
  autoUpdater.on('checking-for-update', () => console.log('[UPDATER] Checking for updates...'));
  autoUpdater.on('update-available', () => console.log('[UPDATER] Update available!'));
  autoUpdater.on('update-not-available', () => console.log('[UPDATER] App is up to date.'));
  registerAllIPCs();

  const getIconPath = () => {
    const isDark = nativeTheme.shouldUseDarkColors;
    const fileName = isDark ? 'logo-white.png' : 'logo.png';
    
    return app.isPackaged 
      ? path.join(process.resourcesPath, fileName) 
      : path.join(__dirname, '../public', fileName);
  };

  const mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1024,
    minHeight: 700,
    title: "MakeVideoSmall",
    icon: getIconPath(),
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#09090b',
      symbolColor: '#ffffff',
      height: 32
    },

    show: false,

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  nativeTheme.on('updated', () => {
    mainWindow.setIcon(getIconPath());
  });

 mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();

    // 1. Check for updates ONLY after the window is ready
    if (!isDev()) {
      autoUpdater.checkForUpdatesAndNotify();
    }
  });

  // 2. Tell React when the update is fully downloaded and ready to install
  autoUpdater.on('update-downloaded', () => {
    console.log('[UPDATER] Update downloaded! Notifying React...');
    mainWindow.webContents.send('update-downloaded');
  });

  // 3. Listen for React telling us the user clicked "Restart"
  ipcMain.on('restart-to-update', () => {
    autoUpdater.quitAndInstall();
  });

  mainWindow.webContents.on('devtools-opened', () => {
  if (app.isPackaged) {
    mainWindow.webContents.closeDevTools();
  }
});

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  });

  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    event.preventDefault();
  });

mainWindow.webContents.on('before-input-event', (event, input) => {
  if (input.control && (input.key === '-' || input.key === '=' || input.key === '+')) {
    event.preventDefault();
  }

  if (app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'i') {
    event.preventDefault();
  }
});

ipcMain.handle('toggle-dev-tools', (event, show) => {
  if (show) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.webContents.closeDevTools();
  }
});

if (isDev()) {
    mainWindow.loadURL("http://localhost:5123/");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist-react", "index.html"));
  }
});