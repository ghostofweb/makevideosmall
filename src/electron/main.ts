import { app, BrowserWindow, protocol, net } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { isDev } from "./util.js";
import { registerAllIPCs } from "./api/index.js";

// 1. Tell Electron that 'local://' is a safe, privileged network scheme
protocol.registerSchemesAsPrivileged([
  { scheme: 'local', privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }
]);

app.on("ready", () => {
  protocol.handle('local', (request) => {
   let filePath = request.url.replace(/^local:\/\/\//i, '');
    filePath = decodeURIComponent(filePath);
   return net.fetch(pathToFileURL(filePath).href);
  });

  // Boot Backend APIs
  registerAllIPCs();

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  if (isDev() == "development") {
    mainWindow.loadURL("http://localhost:5123/");
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist-react', 'index.html'));
  }
});