require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const geoip = require('geoip-lite');

// IMPORT CÁC HÀM TỪ FILE telegramClient.js VÀO ĐÂY
const { initTelegram, clickCheckCompletionButton, sendTelegramCommand } = require('./telegramClient');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Trạng thái Server
let devices = {};
let autoPplinkOn = false;
let linkDelay = 5000; 

// Hàm dùng để Telegram gọi ngược lại khi có link mới
function distributeLink(url, msgId) {
    const idleDevice = Object.values(devices).find(d => d.status === 'idle');
    if (idleDevice) {
        devices[idleDevice.id].status = 'working';
        io.emit('UPDATE_DEVICES', Object.values(devices)); 
        io.to(idleDevice.id).emit('OPEN_LINK', { url, msgId });
        io.emit("UPDATE_LOG", `[Hệ thống] Đã giao link ${msgId} cho thiết bị IP ${idleDevice.ip}`);
    } else {
        io.emit("UPDATE_LOG", `[Cảnh báo] Nhận được link nhưng không có thiết bị rảnh!`);
    }
}

// Hàm cung cấp trạng thái Auto cho Telegram
const getAutoStatus = () => autoPplinkOn;

// KHỞI TẠO TELEGRAM USERBOT NGAY KHI CHẠY SERVER
initTelegram(io, distributeLink, getAutoStatus);

// Xử lý Socket.io (Thiết bị Web)
io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] || socket.request.connection.remoteAddress;
    const geo = geoip.lookup(ip);
    
    devices[socket.id] = { id: socket.id, ip: ip, country: geo ? geo.country : 'Unknown', status: 'idle' };
    io.emit('UPDATE_DEVICES', Object.values(devices));

    socket.on('disconnect', () => { 
        delete devices[socket.id]; 
        io.emit('UPDATE_DEVICES', Object.values(devices)); 
    });

    socket.on('TOGGLE_AUTOPPLINK', (status) => {
        autoPplinkOn = status;
        io.emit("UPDATE_LOG", `[Hệ thống] Auto-PPLink: ${status ? 'BẬT' : 'TẮT'}`);
    });
    
    socket.on('SET_DELAY', (ms) => linkDelay = ms);

    // Khi Extension trên trình duyệt làm xong nhiệm vụ
    socket.on('URL_REACHED', async ({ msgId }) => {
        if(devices[socket.id]) {
            devices[socket.id].status = 'idle';
            io.emit('UPDATE_DEVICES', Object.values(devices));
            // Gọi hàm ấn nút bên file telegramClient.js
            await clickCheckCompletionButton(msgId, devices[socket.id].ip, io);
        }
    });

    // Lệnh từ giao diện Web UI
    socket.on('SEND_COMMAND', async (command) => {
        if (command === '/withdraw') {
            io.emit("UPDATE_LOG", `[Hệ thống] Tạm dừng Auto. Bắt đầu luồng rút tiền...`);
            await sendTelegramCommand(command, true);
        } else {
            if (autoPplinkOn) {
                const deviceCount = Object.keys(devices).length;
                io.emit("UPDATE_LOG", `[Hệ thống] Gửi ${deviceCount} lệnh (Delay: ${linkDelay/1000}s)`);
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