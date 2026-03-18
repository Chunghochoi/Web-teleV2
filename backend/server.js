const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { initTelegram, sendCommand, checkTaskCompletion, triggerWithdraw } = require('./telegram');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let devices = {}; // Quản lý IP
let tasks = {};   // { link: { status, timer, retries, messageId } }
let isTargeting = false;
let currentTarget = 0;
let tasksCompleted = 0;

io.on('connection', (socket) => {
    const ip = socket.handshake.address;
    devices[socket.id] = { ip: ip, status: 'idle', country: 'VN' };
    io.emit('device_update', devices);

    // Lệnh yêu cầu Link
    socket.on('request_link', async (data) => {
        const { type, autoPP, delay } = data; // type: /uptolink2step
        if (autoPP) {
            const idleCount = Object.values(devices).filter(d => d.status === 'idle').length;
            for (let i = 0; i < idleCount; i++) {
                await sendCommand(type);
                await new Promise(r => setTimeout(r, delay * 1000));
            }
        } else {
            await sendCommand(type);
        }
    });

    // Extension báo đã mở tab
    socket.on('task_started', (data) => {
        const { url, messageId } = data;
        devices[socket.id].status = 'working';
        io.emit('device_update', devices);
        
        tasks[url] = { status: 'working', retries: tasks[url]?.retries || 0, messageId };
        
        // Timeout 180s
        tasks[url].timer = setTimeout(() => {
            if (tasks[url] && tasks[url].status !== 'done') {
                handleTaskFail(url, socket.id, "Timeout 180s");
            }
        }, 180000);
    });

    // Extension báo truy cập đích thành công
    socket.on('task_reached_dest', async (data) => {
        const { url } = data;
        if (tasks[url]) {
            clearTimeout(tasks[url].timer);
            tasks[url].status = 'done';
            devices[socket.id].status = 'idle';
            io.emit('device_update', devices);
            
            // Bấm kiểm tra hoàn thành
            await checkTaskCompletion(tasks[url].messageId, io);
            
            tasksCompleted++;
            if (tasksCompleted % 30 === 0) sendCommand('/spin');
            if (tasksCompleted % 50 === 0) sendCommand('/top');

            // Chạy tiếp nếu bật Target
            if (isTargeting && tasksCompleted < currentTarget) {
                sendCommand('/uptolink2step'); // Mặc định tiếp tục 2 step
            }
        }
    });

    // Extension báo lỗi (Notraffic, v.v.)
    socket.on('task_error', (data) => {
        handleTaskFail(data.url, socket.id, data.reason);
    });

    // Rút tiền & Target
    socket.on('withdraw', () => triggerWithdraw());
    socket.on('set_target', (data) => { isTargeting = data.isOn; currentTarget = data.target; });
    socket.on('disconnect', () => { delete devices[socket.id]; io.emit('device_update', devices); });
});

function handleTaskFail(url, socketId, reason) {
    console.log(`[Task Failed] ${url} - ${reason}`);
    clearTimeout(tasks[url]?.timer);
    
    if (tasks[url].retries < 2) {
        tasks[url].retries++;
        io.to(socketId).emit('close_task_tab', { url });
        setTimeout(() => io.to(socketId).emit('retry_link', { url }), 3000);
    } else {
        delete tasks[url];
        devices[socketId].status = 'idle';
        io.to(socketId).emit('close_task_tab', { url });
        sendCommand('/uptolink2step'); // Xin link mới bỏ qua link lỗi
    }
}

initTelegram(io).then(() => server.listen(3000, () => console.log('Server running port 3000')));