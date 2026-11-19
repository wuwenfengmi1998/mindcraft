import settings from '../settings.js';
import { getVersion } from 'prismarine-viewer/viewer/lib/version.js';
import { serverProxy } from '../mindserver_proxy.js';
import { getViewerSocketPath, startViewerServer } from './viewer_server.js';

function reportViewerStatus(status) {
    try {
        serverProxy.reportViewerStatus(status);
    } catch (err) {
        console.warn('Failed to report viewer status:', err.message);
    }
}

export async function addBrowserViewer(bot) {
    if (!settings.render_bot_view) {
        reportViewerStatus({ state: 'disabled' });
        return;
    }

    const viewerVersion = getVersion(bot.version);
    if (!viewerVersion) {
        const error = `prismarine-viewer 不支持 Minecraft ${bot.version}`;
        console.warn(`Browser viewer disabled: ${error}`);
        reportViewerStatus({ state: 'unsupported', error, botVersion: bot.version });
        return;
    }

    reportViewerStatus({ state: 'starting', botVersion: bot.version, viewerVersion });

    const socketPath = getViewerSocketPath();
    try {
        console.log(`Browser viewer starting on ${socketPath} (Minecraft ${bot.version})`);
        await startViewerServer(bot, { socketPath, firstPerson: true });
        console.log(`Prismarine viewer ready on ${socketPath}`);
        reportViewerStatus({ state: 'ready', socketPath, botVersion: bot.version, viewerVersion });
    } catch (err) {
        const error = err.message || String(err);
        console.warn('Browser viewer failed:', error);
        reportViewerStatus({ state: 'error', error, botVersion: bot.version, viewerVersion });
    }
}
