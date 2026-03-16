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
let isTargetEnabled = true;
let linkDelay = 5000;

// Trạng thái nhiệm vụ & Timeout
let taskTimers = {}; 
let taskRetries = {};

// Biến quản lý Vòng lặp
let currentTarget = 0;
let currentCompleted = 0;
let activeCommand = '';
let activeSocketId = null; // Dùng khi Auto-PPLink TẮT (Chạy đơn)

function distributeLink(url, msgId) {
    let targetDevice = null;

    if (autoPplinkOn) {
        targetDevice = Object.values(devices).find(d => d.status === 'idle');
    } else {
        // Chạy đơn thiết bị
        if (devices[activeSocketId] && devices[activeSocketId].status === 'idle') {
            targetDevice = devices[activeSocketId];
        }
    }

    if (targetDevice) {
        targetDevice.status = 'working'; 
        io.emit('UPDATE_DEVICES', Object.values(devices)); 
        io.to(targetDevice.id).emit('OPEN_LINK', { url, msgId });
        io.emit("UPDATE_LOG", `[Hệ thống] Đã giao link cho IP ${targetDevice.ip}`);

        // TÍNH NĂNG MỚI: BỘ ĐẾM 180 GIÂY
        if (taskTimers[msgId]) clearTimeout(taskTimers[msgId]);
        taskTimers[msgId] = setTimeout(() => {
            handleTaskFailure(msgId, targetDevice.id, url);
        }, 180000); // 180 giây
    } else {
        io.emit("UPDATE_LOG", `[Cảnh báo] Mọi thiết bị đang bận! Lệnh bị kẹt.`);
    }
}

// XỬ LÝ KHI LỖI / TIMEOUT / 404
function handleTaskFailure(msgId, socketId, url) {
    io.emit("UPDATE_LOG", `⚠️ [Timeout/Lỗi] Nhiệm vụ ${msgId} thất bại. Đang xử lý...`);
    
    // Đóng tab trên thiết bị đó
    io.to(socketId).emit('FORCE_CLOSE_TABS', { msgId });
    if(devices[devices[socketId]?.ip]) devices[devices[socketId].ip].status = 'idle';
    io.emit('UPDATE_DEVICES', Object.values(devices));

    if (!taskRetries[msgId]) taskRetries[msgId] = 0;
    taskRetries[msgId]++;

    if (taskRetries[msgId] <= 1) {
        io.emit("UPDATE_LOG", `🔄 Đang mở lại link ${msgId} lần 2...`);
        setTimeout(() => distributeLink(url, msgId), 2000);
    } else {
        io.emit("UPDATE_LOG", `❌ Link hỏng hoàn toàn. Xin link mới...`);
        sendTelegramCommand(activeCommand, false);
    }
}

const getAutoStatus = () => autoPplinkOn;

const onTaskApproved = () => {
    currentCompleted++;
    io.emit("UPDATE_LOG", `🏆 Tiến độ: ${currentCompleted} / ${isTargetEnabled ? currentTarget : '∞'} NV`);
    
    if (isTargetEnabled && currentCompleted >= currentTarget) {
        io.emit("UPDATE_LOG", `🎉 ĐÃ HOÀN THÀNH MỤC TIÊU ${currentTarget} NHIỆM VỤ! Vòng lặp dừng.`);
        currentTarget = 0; 
    } else {
        // Tự gọi link mới (Auto bật HOẶC Target bật)
        if (autoPplinkOn || isTargetEnabled) {
            setTimeout(async () => {
                await sendTelegramCommand(activeCommand, false);
            }, 2000); 
        }
    }
};

initTelegram(io, distributeLink, getAutoStatus, onTaskApproved);

io.on('connection', (socket) => {
    // WEB UI ĐĂNG KÝ (Định danh bằng IP web)
    socket.on('REGISTER_UI', () => {
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

    socket.on('UPDATE_SETTINGS', (settings) => {
        autoPplinkOn = settings.auto;
        isTargetEnabled = settings.targetEnabled;
        linkDelay = settings.delay;
    });

    // BÁO CÁO LỖI TỪ EXTENSION (404, Notraffic)
    socket.on('REPORT_ERROR', ({ msgId, url }) => {
        if (taskTimers[msgId]) clearTimeout(taskTimers[msgId]);
        handleTaskFailure(msgId, socket.id, url);
    });

    socket.on('URL_REACHED', async ({ msgId }) => {
        if (taskTimers[msgId]) clearTimeout(taskTimers[msgId]); // Hủy đếm giờ
        const ipKey = Object.keys(devices).find(ip => devices[ip].id === socket.id);
        if(ipKey) {
            devices[ipKey].status = 'idle'; // Chuẩn "Rảnh": Đã xong việc, ko có link chờ
            io.emit('UPDATE_DEVICES', Object.values(devices));
            await clickCheckCompletionButton(msgId, devices[ipKey].ip, io);
        }
    });

    socket.on('SEND_COMMAND', async ({ command, target }) => {
        if (command === '/withdraw') {
            await sendTelegramCommand(command, true);
        } else {
            activeCommand = command;
            currentTarget = target;
            currentCompleted = 0; 
            activeSocketId = socket.id; // Lưu lại ID thiết bị ra lệnh nếu chạy đơn

            if (autoPplinkOn) {
                const idleDevices = Object.values(devices).filter(d => d.status === 'idle');
                const deviceCount = isTargetEnabled ? Math.min(idleDevices.length, currentTarget) : idleDevices.length;
                if (deviceCount === 0) return;

                io.emit("UPDATE_LOG", `[Khởi động] Gửi ${deviceCount} lệnh Đa thiết bị`);
                for (let i = 0; i < deviceCount; i++) {
                    setTimeout(async () => { await sendTelegramCommand(activeCommand, false); }, i * linkDelay);
                }
            } else {
                io.emit("UPDATE_LOG", `[Khởi động] Chạy Đơn trên thiết bị hiện tại`);
                await sendTelegramCommand(command, false);
            }
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log(`🚀 Server chạy`));
