const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const geoip = require('geoip-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let devices = {};
let autoPplinkOn = false;
let linkDelay = 5000;

io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.request.connection.remoteAddress;
    const geo = geoip.lookup(ip);
    devices[socket.id] = { id: socket.id, ip: ip, country: geo ? geo.country : 'Unknown', status: 'idle' };
    
    io.emit('UPDATE_DEVICES', Object.values(devices));

    socket.on('DISCONNECT', () => { delete devices[socket.id]; io.emit('UPDATE_DEVICES', Object.values(devices)); });

    // Cấu hình từ Web UI
    socket.on('TOGGLE_AUTOPPLINK', (status) => autoPplinkOn = status);
    socket.on('SET_DELAY', (ms) => linkDelay = ms);

    // Xử lý khi Extenstion báo đã truy cập thành công tên miền
    socket.on('URL_REACHED', async ({ url, msgId }) => {
        try {
            await clickCheckCompletionButton(msgId); // GramJS ấn nút
            io.emit("UPDATE_LOG", `Đã ấn kiểm tra hoàn thành cho thiết bị ${devices[socket.id].ip}`);
        } catch (e) {
            io.emit("ERROR", `Lỗi ấn nút: ${e.message}`);
        }
    });

    // Client gửi lệnh Web
    socket.on('SEND_COMMAND', async (command) => {
        if(command === '/withdraw') { /* Gọi logic tạm dừng tasks, gửi withdraw */ }
        else {
            if (autoPplinkOn) {
                const deviceCount = Object.keys(devices).length;
                for (let i = 0; i < deviceCount; i++) {
                    setTimeout(() => client.sendMessage(ID_CUA_BOT_CRYPTO, { message: command }), i * linkDelay);
                }
            } else {
                client.sendMessage(ID_CUA_BOT_CRYPTO, { message: command });
            }
        }
    });
});

// Phân phát link cho máy đang rảnh
function distributeLink(linkObj) {
    const idleDevice = Object.values(devices).find(d => d.status === 'idle');
    if (idleDevice) {
        devices[idleDevice.id].status = 'working';
        io.to(idleDevice.id).emit('OPEN_LINK', linkObj);
    }
}