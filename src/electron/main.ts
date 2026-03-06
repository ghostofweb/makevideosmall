import { app, BrowserWindow, protocol, net, nativeTheme, ipcMain } from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { isDev } from "./util.js";
import { registerAllIPCs } from "./api/index.js";

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
  });

  mainWindow.webContents.on('devtools-opened', () => {
  if (app.isPackaged) {
    mainWindow.webContents.closeDevTools();
  }
});

mainWindow.webContents.on('before-input-event', (event, input) => {
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