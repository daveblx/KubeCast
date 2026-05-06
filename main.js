import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  if (isDev) {
    // In development, we use Vite on port 3000
    mainWindow.loadURL('http://localhost:3000');
  } else {
    // In production, run the bundled Express server in the main process
    try {
      // Set DB and dist paths to prevent writing to read-only app package
      process.env.NODE_ENV = 'production';
      process.env.DB_PATH = path.join(app.getPath('userData'), 'db.json');
      process.env.DIST_PATH = path.join(__dirname, 'dist');
      
      // Dynamically import the backend server
      await import('./dist/server.js');
      console.log('Backend server started.');
      
      // Load the app via the localhost proxy since Vite serves via Express
      mainWindow.loadURL('http://localhost:3000');
    } catch (e) {
      console.error('Failed to start bundled backend server:', e);
    }
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

process.on('exit', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
