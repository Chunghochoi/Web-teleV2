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

// BIẾN QUẢN LÝ VÒNG LẶP NHIỆM VỤ
let currentTarget = 0;
let currentCompleted = 0;
let activeCommand = '';

function distributeLink(url, msgId) {
    const idleDevice = Object.values(devices).find(d => d.status === 'idle');
    if (idleDevice) {
        devices[idleDevice.ip].status = 'working'; 
        io.emit('UPDATE_DEVICES', Object.values(devices)); 
        io.to(idleDevice.id).emit('OPEN_LINK', { url, msgId });
        io.emit("UPDATE_LOG", `[Hệ thống] Đã giao link cho thiết bị IP ${idleDevice.ip}`);
    } else {
        io.emit("UPDATE_LOG", `[Cảnh báo] Mọi thiết bị đang bận!`);
    }
}

const getAutoStatus = () => autoPplinkOn;

// HÀM CHẠY KHI NHIỆM VỤ ĐƯỢC ADMIN DUYỆT THÀNH CÔNG
const onTaskApproved = () => {
    currentCompleted++;
    io.emit("UPDATE_LOG", `🏆 Tiến độ: ${currentCompleted} / ${currentTarget} NV`);
    
    // Nếu chưa đủ mục tiêu và Auto đang bật -> Tự động gọi link mới
    if (currentCompleted < currentTarget && autoPplinkOn) {
        setTimeout(async () => {
            io.emit("UPDATE_LOG", `[Hệ thống] Đang tự động gọi link tiếp theo...`);
            await sendTelegramCommand(activeCommand, false);
        }, 2000); // Đợi 2s rồi gọi để tránh spam
    } else if (currentCompleted >= currentTarget) {
        io.emit("UPDATE_LOG", `🎉 ĐÃ HOÀN THÀNH MỤC TIÊU ${currentTarget} NHIỆM VỤ! Vòng lặp dừng.`);
        currentTarget = 0; // Reset
    }
};

initTelegram(io, distributeLink, getAutoStatus, onTaskApproved);

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
        if (ipKey) { delete devices[ipKey]; io.emit('UPDATE_DEVICES', Object.values(devices)); }
    });

    socket.on('TOGGLE_AUTOPPLINK', (status) => { autoPplinkOn = status; });
    socket.on('SET_DELAY', (ms) => { linkDelay = ms; });

    // KHI EXTENSION LÀM XONG TRÊN WEB
    socket.on('URL_REACHED', async ({ msgId }) => {
        const ipKey = Object.keys(devices).find(ip => devices[ip].id === socket.id);
        if(ipKey) {
            devices[ipKey].status = 'idle'; // Đặt máy thành rảnh
            io.emit('UPDATE_DEVICES', Object.values(devices));
            
            // Yêu cầu Bot ấn nút "Kiểm tra hoàn thành"
            await clickCheckCompletionButton(msgId, devices[ipKey].ip, io);
        }
    });

    // KHI ẤN NÚT LỆNH TRÊN WEB UI
    socket.on('SEND_COMMAND', async ({ command, target }) => {
        if (command === '/withdraw') {
            await sendTelegramCommand(command, true);
        } else {
            activeCommand = command;
            currentTarget = target;
            currentCompleted = 0; // Reset bộ đếm

            if (autoPplinkOn) {
                const idleDevices = Object.values(devices).filter(d => d.status === 'idle');
                const deviceCount = Math.min(idleDevices.length, currentTarget);

                if (deviceCount === 0) return;

                io.emit("UPDATE_LOG", `[Khởi động] Gửi ${deviceCount} lệnh (Mục tiêu: ${currentTarget} NV)`);
                for (let i = 0; i < deviceCount; i++) {
                    setTimeout(async () => {
                        await sendTelegramCommand(activeCommand, false);
                    }, i * linkDelay);
                }
            } else {
                await sendTelegramCommand(command, false);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Node.js & Socket.io đang chạy tại Port ${PORT}`);
});
