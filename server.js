require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const geoip = require('geoip-lite');

const { initTelegram, clickCheckCompletionButton, sendTelegramCommand } = require('./telegramClient');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

let devices = {};
let autoPplinkOn = false;
let linkDelay = 5000;

function distributeLink(url, msgId) {
    const idleDevice = Object.values(devices).find(d => d.status === 'idle');
    if (idleDevice) {
        devices[idleDevice.ip].status = 'working'; 
        io.emit('UPDATE_DEVICES', Object.values(devices)); 
        io.to(idleDevice.id).emit('OPEN_LINK', { url, msgId });
        io.emit("UPDATE_LOG", `[Hệ thống] Đã giao link ${msgId} cho thiết bị IP ${idleDevice.ip}`);
    } else {
        io.emit("UPDATE_LOG", `[Cảnh báo] Nhận được link nhưng các thiết bị đều đang bận!`);
    }
}

const getAutoStatus = () => autoPplinkOn;
initTelegram(io, distributeLink, getAutoStatus);

io.on('connection', (socket) => {

    socket.on('REGISTER_EXTENSION', () => {
        const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] || socket.request.connection.remoteAddress;
        const geo = geoip.lookup(ip);
        const existingStatus = devices[ip] ? devices[ip].status : 'idle';
        devices[ip] = { id: socket.id, ip: ip, country: geo ? geo.country : 'Unknown', status: existingStatus };
        io.emit('UPDATE_DEVICES', Object.values(devices));
    });

    socket.on('disconnect', () => { 
        const ipKey = Object.keys(devices).find(ip => devices[ip].id === socket.id);
        if (ipKey) {
            delete devices[ipKey];
            io.emit('UPDATE_DEVICES', Object.values(devices));
        }
    });

    socket.on('TOGGLE_AUTOPPLINK', (status) => {
        autoPplinkOn = status;
        io.emit("UPDATE_LOG", `[Hệ thống] Auto-PPLink: ${status ? 'BẬT' : 'TẮT'}`);
    });
    
    socket.on('SET_DELAY', (ms) => { linkDelay = ms; });

    socket.on('URL_REACHED', async ({ msgId }) => {
        const ipKey = Object.keys(devices).find(ip => devices[ip].id === socket.id);
        if(ipKey) {
            devices[ipKey].status = 'idle';
            io.emit('UPDATE_DEVICES', Object.values(devices));
            await clickCheckCompletionButton(msgId, devices[ipKey].ip, io);
        }
    });

    socket.on('SEND_COMMAND', async (command) => {
        if (command === '/withdraw') {
            io.emit("UPDATE_LOG", `[Hệ thống] Tạm dừng Auto. Bắt đầu luồng rút tiền...`);
            await sendTelegramCommand(command, true);
        } else {
            if (autoPplinkOn) {
                const idleDevices = Object.values(devices).filter(d => d.status === 'idle');
                const deviceCount = idleDevices.length;

                if (deviceCount === 0) {
                    io.emit("UPDATE_LOG", `[Hệ thống] Tất cả thiết bị đều đang bận. Bỏ qua lệnh!`);
                    return; 
                }

                io.emit("UPDATE_LOG", `[Hệ thống] Gửi ${deviceCount} lệnh cho máy rảnh (Delay: ${linkDelay/1000}s)`);
                for (let i = 0; i < deviceCount; i++) {
                    setTimeout(async () => {
                        await sendTelegramCommand(command, false);
                    }, i * linkDelay);
                }
            } else {
                io.emit("UPDATE_LOG", `[Hệ thống] Gửi lệnh thủ công: ${command}`);
                await sendTelegramCommand(command, false);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Node.js & Socket.io đang chạy tại Port ${PORT}`);
});
