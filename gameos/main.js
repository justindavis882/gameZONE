const { app, BrowserWindow } = require('electron');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

// Define the current local version of the OS
const CURRENT_OS_VERSION = "1.1.3";
// Updated location for recent.png. Should fix not appearing on some consoles
// Eliminate the white flash of Electron
//

// --- 1. BOOT THE BACKEND SERVER ---
const expressApp = express();
const httpServer = createServer(expressApp);
const io = new Server(httpServer, { cors: { origin: "*" } });

expressApp.use(express.static(path.join(__dirname, 'public')));

// --- SECURE MEDIA STREAMING ROUTE ---
expressApp.get('/stream', (req, res) => {
    const filePath = req.query.path;
    if (filePath && fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Media not found');
    }
});

// --- ICON RESOLVER ENGINE ---
async function getIconBase64(iconName) {
    if (!iconName) return null;
    // NEW: If it's a web link from the Store, just return the URL directly!
    if (iconName.startsWith('http://') || iconName.startsWith('https://')) return iconName;
    
    let pathsToTry = [];
    if (iconName.startsWith('/')) {
        pathsToTry.push(iconName);
    } else {
        const exts = ['.png', '.svg', '.xpm'];
        const baseDirs = [
            '/usr/share/pixmaps/',
            '/usr/share/icons/Mint-Y/apps/128/',
            '/usr/share/icons/Mint-Y/apps/96/',
            '/usr/share/icons/Mint-Y/apps/48/',
            '/usr/share/icons/hicolor/128x128/apps/',
            '/usr/share/icons/hicolor/scalable/apps/',
            '/usr/share/icons/hicolor/48x48/apps/',
            path.join(os.homedir(), '.local/share/icons/hicolor/128x128/apps/'),
            path.join(os.homedir(), '.local/share/icons/hicolor/scalable/apps/')
        ];
        for (let dir of baseDirs) {
            for (let ext of exts) {
                pathsToTry.push(dir + iconName + ext);
            }
        }
    }
    for (let imgPath of pathsToTry) {
        try {
            const data = await fs.promises.readFile(imgPath);
            const mime = imgPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
            return `data:${mime};base64,${data.toString('base64')}`;
        } catch (e) {}
    }
    return null;
}

io.on('connection', (socket) => {
    console.log('[SYSTEM] Controller/UI connected:', socket.id);

    // --- PRELOAD SCRIPT PATH ---
    socket.on('get_preload_path', () => {
        const preloadPath = path.join(__dirname, 'public', 'preload.js');
        socket.emit('receive_preload_path', `file://${preloadPath}`);
    });

    // --- POWER & APP MANAGEMENT ---
    socket.on('launch_app', (command) => {
        console.log(`[EXEC] Launching: ${command}`);
        exec(command, (error) => {
            if (error) console.error(`[EXEC ERROR] Failed to launch: ${error}`);
        });
    });
    
    socket.on('system_reboot', () => {
        console.log('[SYSTEM] Reboot command received.');
        exec('sudo reboot');
    });

    socket.on('system_shutdown', () => {
        console.log('[SYSTEM] Power Off command received.');
        exec('sudo poweroff');
    });

    socket.on('close_os', () => {
        console.log('[SYSTEM] Closing Game OS...');
        app.quit();
    });
    
    socket.on('set_volume', (level) => {
        exec(`pactl set-sink-volume @DEFAULT_SINK@ ${level}%`);
    });

    socket.on('set_display', (resolution) => {
        exec(`xrandr --output $(xrandr | grep " connected primary" | awk '{print $1}') --mode ${resolution}`);
    });

    // --- OTA SYSTEM UPDATER ---
    socket.on('check_update', () => {
        console.log('[SYSTEM] Checking cloud for OS updates...');
        // CHANGE THIS URL TO YOUR GITHUB PAGES URL
        const versionUrl = 'https://raw.githubusercontent.com/justindavis882/gameZONE/main/version.json';
        
        https.get(versionUrl, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const remoteData = JSON.parse(data);
                    if (remoteData.version !== CURRENT_OS_VERSION) {
                        socket.emit('update_available', remoteData);
                    } else {
                        socket.emit('update_none', CURRENT_OS_VERSION);
                    }
                } catch (e) {
                    socket.emit('update_error', 'Cloud data corrupted.');
                }
            });
        }).on('error', () => socket.emit('update_error', 'Cannot connect to GitHub.'));
    });

    socket.on('apply_update', (zipUrl) => {
        console.log('[SYSTEM] Downloading and applying GameOS update...');
        
        // Modified command: Only copies the contents of the 'gameos' folder
        const updateCommand = `curl -L -o update.zip "${zipUrl}" && unzip -q -o update.zip && cp -a *-main/gameos/* . && rm -rf *-main update.zip`;
        
        exec(updateCommand, { cwd: __dirname }, (err, stdout, stderr) => {
            if (err) {
                console.error('[SYSTEM ERROR] Update failed:', err);
                socket.emit('update_error', 'Failed to extract update files.');
            } else {
                console.log('[SYSTEM] Update successful. Rebooting...');
                socket.emit('update_success');
                setTimeout(() => exec('sudo reboot'), 3000); // Reboot Linux
            }
        });
    });

    // --- LIBRARY SCANNER ---
    socket.on('scan_library', async () => {
        console.log('[SYSTEM] Scanning system for apps and games...');
        
        // 1. Define the exclusive Sandbox App Folder
        const kioskAppDir = path.join(os.homedir(), '.gameos-apps');

        // 2. Build the folder automatically if this is the first time booting
        if (!fs.existsSync(kioskAppDir)) {
            fs.mkdirSync(kioskAppDir, { recursive: true });
            console.log('[SYSTEM] Created sandboxed app directory:', kioskAppDir);
        }

        // 3. ONLY scan this specific folder
        const appDirs = [kioskAppDir]; 
        let installedApps = [];

        for (const appDir of appDirs) {
            try {
                const files = await fs.promises.readdir(appDir);
                const desktopFiles = files.filter(file => file.endsWith('.desktop'));
                
                for (const file of desktopFiles) {
                    try {
                        const content = await fs.promises.readFile(path.join(appDir, file), 'utf8');
                        const nameMatch = content.match(/^Name=(.+)$/m);
                        const execMatch = content.match(/^Exec=(.+)$/m);
                        const noDisplayMatch = content.match(/^NoDisplay=(.+)$/m);
                        const iconMatch = content.match(/^Icon=(.+)$/m);

                        const isHidden = noDisplayMatch && noDisplayMatch[1].trim().toLowerCase() === 'true';

                        if (nameMatch && execMatch && !isHidden) {
                            const title = nameMatch[1].trim();
                            const execCmd = execMatch[1].split('%')[0].trim(); 
                            const iconHint = iconMatch ? iconMatch[1].trim() : null;

                            if (!installedApps.some(app => app.title === title)) {
                                const resolvedIcon = await getIconBase64(iconHint);
                                installedApps.push({
                                    id: title,
                                    title: title,
                                    type: 'local',
                                    exec: execCmd,
                                    iconData: resolvedIcon,
                                    desc: `GameOS App`
                                });
                            }
                        }
                    } catch (e) {}
                }
            } catch (err) {}
        }
        
        installedApps.sort((a, b) => a.title.localeCompare(b.title));
        socket.emit('library_scan_results', installedApps);
    });

    // --- APP STORE INSTALLER ---
    socket.on('install_app', async (appData) => {
        console.log(`[SYSTEM] Installing app from Store: ${appData.title}`);
        try {
            // 1. Simulate a premium "Download" sequence for UX and system buffering
            for (let i = 10; i <= 90; i += 20) {
                await new Promise(resolve => setTimeout(resolve, 400));
                socket.emit('install_progress', { title: appData.title, progress: i });
            }

            // 2. Write the file
            const kioskAppDir = path.join(os.homedir(), '.gameos-apps');
            if (!fs.existsSync(kioskAppDir)) fs.mkdirSync(kioskAppDir, { recursive: true });

            const safeFilename = appData.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.desktop';
            const desktopPath = path.join(kioskAppDir, safeFilename);
            const execCommand = appData.type === 'web' ? `GAMEOS_WEB:${appData.url}` : appData.exec;

            const desktopFileContent = [
                '[Desktop Entry]',
                `Name=${appData.title}`,
                `Exec=${execCommand}`,
                `Icon=${appData.icon}`,
                'Type=Application',
                'Categories=GameOS;'
            ].join('\n');

            await fs.promises.writeFile(desktopPath, desktopFileContent);
            await fs.promises.chmod(desktopPath, 0o755); 
            
            // 3. Complete the progress bar
            socket.emit('install_progress', { title: appData.title, progress: 100 });
            console.log(`[SYSTEM] App installed successfully: ${desktopPath}`);
            socket.emit('install_success', `${appData.title} has been added to your Library!`);
            
            // 4. Wait 500ms for Linux to flush the file to disk, THEN silently scan
            setTimeout(() => {
                socket.emit('scan_library'); 
            }, 500);

        } catch (err) {
            console.error('[SYSTEM ERROR] Failed to install app:', err);
            socket.emit('install_error', `Failed to install ${appData.title}`);
        }
    });

    // --- FILE SYSTEM ENGINE (CRUD & MEDIA) ---
    
    // Get total system storage space
    socket.on('get_storage_info', () => {
        exec("df -h /", (err, stdout) => {
            if (err) return;
            const lines = stdout.trim().split('\n');
            if (lines.length > 1) {
                // Parse standard Linux df output (Size, Used, Avail, Use%)
                const parts = lines[1].replace(/\s+/g, ' ').split(' ');
                socket.emit('storage_info', { total: parts[1], free: parts[3], percent: parts[4] });
            }
        });
    });

    // Detect inserted USB flash drives
    socket.on('get_usb_drives', async () => {
        try {
            // Linux Mint auto-mounts USBs here
            const userMediaDir = path.join('/media', os.userInfo().username);
            if (fs.existsSync(userMediaDir)) {
                const drives = await fs.promises.readdir(userMediaDir);
                socket.emit('usb_list', drives);
            } else {
                socket.emit('usb_list', []);
            }
        } catch (e) {
            socket.emit('usb_list', []);
        }
    });

    // Handle File Deletion
    socket.on('delete_file', (filePath) => {
        // Ensure the path is inside our allowed directories to be safe
        if (filePath.includes('.gameos-apps') || filePath.includes('media')) {
            fs.unlink(filePath, (err) => {
                if (err) console.error(err);
                else {
                    socket.emit('scan_library'); // Refresh the list
                    console.log(`[SYSTEM] Deleted: ${filePath}`);
                }
            });
        }
    });

    // Handle USB Export (Copy then Delete to safely cross disk partitions)
    socket.on('export_to_usb', async ({ filePath, usbName }) => {
        try {
            const destPath = path.join('/media', os.userInfo().username, usbName, path.basename(filePath));
            await fs.promises.copyFile(filePath, destPath);
            await fs.promises.unlink(filePath); 
            socket.emit('file_action_success', `Moved successfully to ${usbName}.`);
        } catch (e) {
            socket.emit('file_action_error', 'Transfer failed. Check USB space and permissions.');
        }
    });

    // Upgraded Media Scanner (Now includes Audio and USB Drives)
    socket.on('scan_media', async () => {
        console.log('[SYSTEM] Scanning file system...');
        
        const mediaDirs = [
            path.join(os.homedir(), 'Pictures'),
            path.join(os.homedir(), 'Videos'),
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Music')
        ];

        // Also sweep any currently plugged-in USB drives
        try {
            const userMediaDir = path.join('/media', os.userInfo().username);
            if (fs.existsSync(userMediaDir)) {
                const drives = await fs.promises.readdir(userMediaDir);
                drives.forEach(drive => mediaDirs.push(path.join(userMediaDir, drive)));
            }
        } catch(e) {}
        
        const validExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mkv', '.mp3', '.wav', '.ogg', '.flac'];
        let discoveredMedia = [];

        for (const dir of mediaDirs) {
            try {
                if (!fs.existsSync(dir)) continue;
                const files = await fs.promises.readdir(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    try {
                        const stat = await fs.promises.stat(fullPath);
                        if (stat.isFile()) {
                            const ext = path.extname(file).toLowerCase();
                            if (validExtensions.includes(ext)) {
                                let type = 'photo';
                                if (['.mp4', '.webm', '.mkv'].includes(ext)) type = 'video';
                                if (['.mp3', '.wav', '.ogg', '.flac'].includes(ext)) type = 'audio';
                                
                                discoveredMedia.push({
                                    id: fullPath, // Use absolute path as ID for CRUD ops
                                    title: file,
                                    type: type,
                                    path: fullPath,
                                    size: (stat.size / (1024 * 1024)).toFixed(2) + ' MB',
                                    url: `http://localhost:3000/stream?path=${encodeURIComponent(fullPath)}`
                                });
                            }
                        }
                    } catch (fileErr) {}
                }
            } catch (err) {}
        }
        discoveredMedia.sort((a, b) => b.title.localeCompare(a.title));
        socket.emit('media_scan_results', discoveredMedia);
    });

    // --- CAMERA & SCREENSHOT SAVING ---
    socket.on('take_screenshot', async () => {
        console.log('[SYSTEM] Taking screenshot...');
        try {
            const image = await mainWindow.webContents.capturePage();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filePath = path.join(os.homedir(), 'Pictures', `Screenshot_${timestamp}.png`);
            await fs.promises.writeFile(filePath, image.toPNG());
            console.log('[SYSTEM] Screenshot saved to:', filePath);
        } catch (err) {
            console.error('[SYSTEM ERROR] Screenshot failed:', err);
        }
    });

    socket.on('save_camera_photo', async (base64Data) => {
        console.log('[SYSTEM] Saving camera photo...');
        try {
            const base64Image = base64Data.split(';base64,').pop();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filePath = path.join(os.homedir(), 'Pictures', `Webcam_${timestamp}.png`);
            await fs.promises.writeFile(filePath, base64Image, {encoding: 'base64'});
            console.log('[SYSTEM] Photo saved to:', filePath);
        } catch (err) {
            console.error('[SYSTEM ERROR] Photo save failed:', err);
        }
    });

    // --- BLUETOOTH ENGINE ---
    socket.on('get_bluetooth_status', () => {
        exec("bluetoothctl show | grep 'Powered: yes'", (err, stdout) => {
            socket.emit('bluetooth_status', stdout.trim() ? 'ON' : 'OFF');
        });
    });

    socket.on('scan_bluetooth', () => {
        console.log('[SYSTEM] Scanning for Bluetooth devices...');
        // Force power on, then scan for 5 seconds
        exec("bluetoothctl power on && bluetoothctl --timeout 5 scan on", () => {
            exec("bluetoothctl devices", (err, stdout) => {
                if (err) return socket.emit('bluetooth_scan_results', []);
                
                // Parse the Linux output (e.g. "Device XX:XX:XX:XX:XX:XX Controller Name")
                const devices = stdout.split('\n').filter(line => line.includes('Device')).map(line => {
                    const parts = line.split(' ');
                    const mac = parts[1];
                    const name = parts.slice(2).join(' ');
                    return { mac, name: name || 'Unknown Device' };
                });
                
                socket.emit('bluetooth_scan_results', devices);
            });
        });
    });

    socket.on('connect_bluetooth', (mac) => {
        console.log(`[SYSTEM] Attempting to pair and connect to ${mac}...`);
        exec(`bluetoothctl pair ${mac} && bluetoothctl trust ${mac} && bluetoothctl connect ${mac}`, (err, stdout, stderr) => {
            const output = stdout + stderr;
            if (err || output.includes('Failed')) {
                socket.emit('bluetooth_connect_result', { success: false, error: 'Pairing/Connection refused.' });
            } else {
                socket.emit('bluetooth_connect_result', { success: true, mac });
            }
        });
    });

    // --- NETWORK LOGIC ---
    socket.on('get_network', () => {
        exec("nmcli -t -f TYPE,STATE con show --active", (err, stdout) => {
            if (stdout.includes('ethernet:activated')) socket.emit('network_status', 'Wired (Ethernet)');
            else if (stdout.includes('802-11-wireless:activated')) {
                exec("nmcli -t -f active,ssid dev wifi | grep '^yes'", (err2, stdout2) => {
                    socket.emit('network_status', `Wi-Fi: ${stdout2.split(':')[1]?.trim() || 'Connected'}`);
                });
            } else socket.emit('network_status', 'Disconnected');
        });
    });

    socket.on('scan_wifi', () => {
        exec("nmcli -t -f ssid,signal,security dev wifi list", (err, stdout) => {
            if (err) return socket.emit('wifi_scan_results', []);
            const networks = stdout.split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    const [ssid, signal, security] = line.split(':');
                    return { ssid, signal: parseInt(signal) || 0, security };
                })
                .filter((net, index, self) => net.ssid && index === self.findIndex((t) => t.ssid === net.ssid))
                .sort((a, b) => b.signal - a.signal);
            socket.emit('wifi_scan_results', networks);
        });
    });

    socket.on('connect_wifi', ({ ssid, password }) => {
        exec(`nmcli dev wifi connect "${ssid}" password "${password}"`, (err, stdout, stderr) => {
            if (err) {
                const errorLog = stderr || stdout || "Unknown error";
                let msg = "Connection failed.";
                if (errorLog.includes('Secrets were required')) msg = "Incorrect password.";
                else if (errorLog.includes('No network')) msg = "Out of range.";
                socket.emit('wifi_connect_result', { success: false, error: msg });
            } else socket.emit('wifi_connect_result', { success: true });
        });
    });
});

httpServer.listen(3000, '0.0.0.0', () => console.log('[BRIDGE] Active on port 3000'));

// --- 2. BOOT THE NATIVE LINUX WINDOW ---
const { powerSaveBlocker } = require('electron'); // <-- Add this to the top of your file if it isn't there, or just pull it from the electron require!

// --- 2. BOOT THE NATIVE LINUX WINDOW ---
let mainWindow;
let sleepBlockerId;

app.whenReady().then(() => {
    // Forcefully prevent the Linux display from sleeping or dimming
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    console.log('[SYSTEM] Power save blocker engaged. ID:', sleepBlockerId);

    mainWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        fullscreen: true,
        frame: false,
        backgroundColor: '#000000',
        show: false,
        webPreferences: {
            nodeIntegration: true,
            webviewTag: true,
            autoplayPolicy: 'no-user-gesture-required' 
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadURL('http://localhost:3000');
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
