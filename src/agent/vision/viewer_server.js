import EventEmitter from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { createRequire } from 'node:module';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import prismarineViewer from 'prismarine-viewer';

// Adapted from prismarine-viewer@1.33.0 lib/mineflayer.js so the viewer can
// listen on a local Unix domain socket (named pipe on Windows) instead of a
// TCP port. MindServer proxies /viewer/<agent>/ to this socket.

const require = createRequire(import.meta.url);
const viewerRoot = path.dirname(require.resolve('prismarine-viewer/package.json'));
const viewerPublicDir = path.join(viewerRoot, 'public');
const { WorldView } = prismarineViewer.viewer;

const SOCKET_PREFIX = 'mindcraft-viewer';

export function getViewerSocketPath() {
    const id = crypto.randomBytes(6).toString('hex');
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\${SOCKET_PREFIX}-${process.pid}-${id}`;
    }
    return path.join(os.tmpdir(), `${SOCKET_PREFIX}-${process.pid}-${id}.sock`);
}

function removeSocketFile(socketPath) {
    if (process.platform === 'win32') return;
    try {
        fs.unlinkSync(socketPath);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`Failed to remove viewer socket ${socketPath}:`, err.message);
        }
    }
}

export function startViewerServer(bot, { socketPath, viewDistance = 6, firstPerson = false } = {}) {
    if (!socketPath) {
        return Promise.reject(new Error('缺少视角 socket 路径'));
    }

    // The path contains random bytes, so any existing file is stale.
    removeSocketFile(socketPath);

    const app = express();
    app.use(express.static(viewerPublicDir));

    const httpServer = http.createServer(app);
    const io = new SocketServer(httpServer); // default path: /socket.io

    const sockets = [];
    const primitives = {};

    bot.viewer = new EventEmitter();

    bot.viewer.erase = (id) => {
        delete primitives[id];
        for (const socket of sockets) {
            socket.emit('primitive', { id });
        }
    };

    bot.viewer.drawBoxGrid = (id, start, end, color = 'aqua') => {
        primitives[id] = { type: 'boxgrid', id, start, end, color };
        for (const socket of sockets) {
            socket.emit('primitive', primitives[id]);
        }
    };

    bot.viewer.drawLine = (id, points, color = 0xff0000) => {
        primitives[id] = { type: 'line', id, points, color };
        for (const socket of sockets) {
            socket.emit('primitive', primitives[id]);
        }
    };

    bot.viewer.drawPoints = (id, points, color = 0xff0000, size = 5) => {
        primitives[id] = { type: 'points', id, points, color, size };
        for (const socket of sockets) {
            socket.emit('primitive', primitives[id]);
        }
    };

    io.on('connection', (socket) => {
        socket.emit('version', bot.version);
        sockets.push(socket);

        const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket);
        worldView.init(bot.entity.position);

        worldView.on('blockClicked', (block, face, button) => {
            bot.viewer.emit('blockClicked', block, face, button);
        });

        for (const id in primitives) {
            socket.emit('primitive', primitives[id]);
        }

        function botPosition() {
            const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true };
            if (firstPerson) {
                packet.pitch = bot.entity.pitch;
            }
            socket.emit('position', packet);
            worldView.updatePosition(bot.entity.position);
        }

        bot.on('move', botPosition);
        worldView.listenToBot(bot);
        socket.on('disconnect', () => {
            bot.removeListener('move', botPosition);
            worldView.removeListenersFromBot(bot);
            const index = sockets.indexOf(socket);
            if (index !== -1) {
                sockets.splice(index, 1);
            }
        });
    });

    const cleanupOnExit = () => removeSocketFile(socketPath);
    process.once('exit', cleanupOnExit);
    httpServer.on('close', () => {
        process.removeListener('exit', cleanupOnExit);
        removeSocketFile(socketPath);
    });

    return new Promise((resolve, reject) => {
        let listening = false;
        let closed = false;

        const onStartupError = (err) => {
            if (listening) return;
            httpServer.removeListener('listening', onListening);
            process.removeListener('exit', cleanupOnExit);
            removeSocketFile(socketPath);
            reject(err);
        };

        const onListening = () => {
            listening = true;
            httpServer.removeListener('error', onStartupError);

            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(socketPath, 0o600);
                } catch (err) {
                    console.warn(`Failed to chmod viewer socket ${socketPath}:`, err.message);
                }
            }

            const close = () => {
                if (closed) return;
                closed = true;
                for (const socket of sockets) {
                    socket.disconnect();
                }
                if (httpServer.listening) {
                    httpServer.close();
                }
            };

            bot.viewer.close = close;
            httpServer.on('error', (err) => {
                console.warn('Viewer server error:', err.message);
            });
            resolve({ socketPath, close });
        };

        httpServer.once('error', onStartupError);
        httpServer.once('listening', onListening);
        httpServer.listen(socketPath);
    });
}
