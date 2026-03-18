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

let taskTimers = {}; 
let taskRetries = {};
let currentTarget = 0;
let currentCompleted = 0;
let activeCommand = '';
let activeSocketId = null;

// HÀM PHÂN PHỐI LINK VỚI CƠ CHẾ PENDING 5 GIÂY
function distributeLink(url, msgId) {
    let targetDevice = null;
    if (autoPplinkOn) targetDevice = Object.values(devices).find(d => d.status === 'idle');
    else if (devices[activeSocketId] && devices[activeSocketId].status === 'idle') targetDevice = devices[activeSocketId];

    if (targetDevice) {
        // Chuyển sang trạng thái ĐANG CHỜ PHẢN HỒI (pending) thay vì working
        targetDevice.status = 'pending'; 
        io.emit('UPDATE_DEVICES', Object.values(devices)); 
        io.to(targetDevice.id).emit('OPEN_LINK', { url, msgId });
        io.emit("UPDATE_LOG", `[Hệ thống] Giao link cho IP ${targetDevice.ip}. Đang đợi Extension mở tab...`);

        // NẾU SAU 5 GIÂY EXTENSION KHÔNG MỞ ĐƯỢC TAB -> HỦY LỆNH VÀ TRẢ VỀ IDLE
        setTimeout(() => {
            if (devices[targetDevice.ip] && devices[targetDevice.ip].status === 'pending') {
                devices[targetDevice.ip].status = 'idle';
                io.emit('UPDATE_DEVICES', Object.values(devices));
                io.emit("UPDATE_LOG", `⚠️ [Lỗi Đồng Bộ] IP ${targetDevice.ip} không phản hồi! Hãy F5 lại trình duyệt trang Web điều khiển.`);
            }
        }, 5000);

    } else {
        io.emit("UPDATE_LOG", `[Cảnh báo] Mọi thiết bị đang bận! Lệnh bị kẹt.`);
    }
}

function handleTaskFailure(msgId, socketId, url) {
    io.emit("UPDATE_LOG", `⚠️ [Timeout/Lỗi] Nhiệm vụ thất bại. Đang xử lý...`);
    io.to(socketId).emit('FORCE_CLOSE_TABS', { msgId });
    if(devices[devices[socketId]?.ip]) devices[devices[socketId].ip].status = 'idle';
    io.emit('UPDATE_DEVICES', Object.values(devices));

    if (!taskRetries[msgId]) taskRetries[msgId] = 0;
    taskRetries[msgId]++;

    if (taskRetries[msgId] <= 1) {
        io.emit("UPDATE_LOG", `🔄 Đang mở lại link lần 2...`);
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
        if (autoPplinkOn || isTargetEnabled) setTimeout(async () => { await sendTelegramCommand(activeCommand, false); }, 2000); 
    }
};

initTelegram(io, distributeLink, getAutoStatus, onTaskApproved);

io.on('connection', (socket) => {
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
        autoPplinkOn = settings.auto; isTargetEnabled = settings.targetEnabled; linkDelay = settings.delay;
    });

    socket.on('RESET_DEVICES', () => {
        Object.values(devices).forEach(d => d.status = 'idle');
        io.emit('UPDATE_DEVICES', Object.values(devices));
        io.emit("UPDATE_LOG", `[Hệ thống] Đã ép toàn bộ thiết bị về trạng thái RẢNH!`);
    });

    socket.on('REPORT_ERROR', ({ msgId, url }) => {
        if (taskTimers[msgId]) clearTimeout(taskTimers[msgId]);
        handleTaskFailure(msgId, socket.id, url);
    });

    // TÍNH NĂNG MỚI: CHÍNH THỨC XÁC NHẬN ĐÃ MỞ TAB VÀ BẮT ĐẦU TÍNH GIỜ
    socket.on('TASK_STARTED', ({ msgId, url }) => {
        const ipKey = Object.keys(devices).find(ip => devices[ip].id === socket.id);
        if(ipKey && devices[ipKey].status === 'pending') {
            devices[ipKey].status = 'working'; // Chốt khóa trạng thái bận
            io.emit('UPDATE_DEVICES', Object.values(devices));
            io.emit("UPDATE_LOG", `🚀 [IP: ${devices[ipKey].ip}] Đã MỞ TAB thành công! Bắt đầu tính giờ 180s...`);

            if (taskTimers[msgId]) clearTimeout(taskTimers[msgId]);
            taskTimers[msgId] = setTimeout(() => { handleTaskFailure(msgId, socket.id, url); }, 180000);
        }
    });

    socket.on('URL_REACHED', async ({ msgId }) => {
        if (taskTimers[msgId]) clearTimeout(taskTimers[msgId]); 
        const ipKey = Object.keys(devices).find(ip => devices[ip].id === socket.id);
        if(ipKey) {
            devices[ipKey].status = 'idle';
            io.emit('UPDATE_DEVICES', Object.values(devices));
            await clickCheckCompletionButton(msgId, devices[ipKey].ip, io);
        }
    });

    socket.on('SEND_COMMAND', async ({ command, target }) => {
        if (command === '/withdraw') { await sendTelegramCommand(command, true); } 
        else {
            activeCommand = command; currentTarget = target; currentCompleted = 0; activeSocketId = socket.id; 
            if (autoPplinkOn) {
                const idleDevices = Object.values(devices).filter(d => d.status === 'idle');
                const deviceCount = isTargetEnabled ? Math.min(idleDevices.length, currentTarget) : idleDevices.length;
                if (deviceCount === 0) return;
                io.emit("UPDATE_LOG", `[Khởi động] Gửi ${deviceCount} lệnh Đa thiết bị`);
                for (let i = 0; i < deviceCount; i++) { setTimeout(async () => { await sendTelegramCommand(activeCommand, false); }, i * linkDelay); }
            } else {
                io.emit("UPDATE_LOG", `[Khởi động] Chạy Đơn trên thiết bị hiện tại`);
                await sendTelegramCommand(command, false);
            }
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log(`🚀 Server chạy`));
