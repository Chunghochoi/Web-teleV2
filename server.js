io.on('connection', (socket) => {
    // Chỉ đăng ký thiết bị khi nó báo danh là Extension
    socket.on('REGISTER_EXTENSION', () => {
        const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] || socket.request.connection.remoteAddress;
        const geo = geoip.lookup(ip);
        
        // FIX LỖI: Dùng IP làm ID duy nhất. Nếu cùng IP vào lại, nó sẽ ghi đè lên thiết bị cũ (Không bị hiện 2 thiết bị nữa)
        devices[ip] = { 
            id: socket.id, 
            ip: ip, 
            country: geo ? geo.country : 'Unknown', 
            status: 'idle' 
        };
        io.emit('UPDATE_DEVICES', Object.values(devices));
    });

    socket.on('disconnect', () => { 
        // Tìm và xóa đúng thiết bị theo socket.id bị mất kết nối
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
    
    socket.on('SET_DELAY', (ms) => linkDelay = ms);

    // Xử lý khi tab vào tới đích
    socket.on('URL_REACHED', async ({ msgId }) => {
        const ipKey = Object.keys(devices).find(ip => devices[ip].id === socket.id);
        if(ipKey) {
            devices[ipKey].status = 'idle'; // Đưa thiết bị về trạng thái rảnh
            io.emit('UPDATE_DEVICES', Object.values(devices));
            
            // Gọi hàm ấn nút telegram
            await clickCheckCompletionButton(msgId, devices[ipKey].ip, io);
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
