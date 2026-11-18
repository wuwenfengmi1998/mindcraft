import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';
import { getVersion } from 'prismarine-viewer/viewer/lib/version.js';
const mineflayerViewer = prismarineViewer.mineflayer;

export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    if (!getVersion(bot.version)) {
        console.warn(`Browser viewer disabled: prismarine-viewer does not support Minecraft ${bot.version}`);
        return;
    }
    mineflayerViewer(bot, { port: 3000+count_id, firstPerson: true, });
}
