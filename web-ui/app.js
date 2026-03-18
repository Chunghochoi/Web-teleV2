const socket = io('https://superidolbot.onrender.com'); // Thay link render của bạn
let isExtensionAlive = false;

// Khôi phục cài đặt từ LocalStorage
document.getElementById('auto-pp').checked = localStorage.getItem('autoPP') === 'true';
document.getElementById('target-mode').checked = localStorage.getItem('targetMode') === 'true';
document.getElementById('target-val').value = localStorage.getItem('targetVal') || '';

// Lưu cài đặt khi thay đổi
document.querySelectorAll('input').forEach(el => {
    el.addEventListener('change', (e) => {
        localStorage.setItem(e.target.id === 'auto-pp' ? 'autoPP' : 
                             e.target.id === 'target-mode' ? 'targetMode' : 'targetVal', 
                             e.target.type === 'checkbox' ? e.target.checked : e.target.value);
        
        if (e.target.id === 'target-mode') {
            socket.emit('set_target', { isOn: e.target.checked, target: document.getElementById('target-val').value });
        }
    });
});

// Giao tiếp với Extension (CustomEvent qua Content Script)
window.addEventListener('message', (event) => {
    if (event.data.type === 'EXT_PONG') {
        isExtensionAlive = true;
        document.getElementById('ext-status').textContent = 'Extension: Đang kết nối (Tốt)';
    }
});

// Ping kiểm tra Extension liên tục (chống ngủ đông / Invalid Context)
setInterval(() => {
    isExtensionAlive = false;
    window.postMessage({ type: 'WEB_PING' }, '*');
    setTimeout(() => {
        if (!isExtensionAlive) {
            document.getElementById('ext-status').textContent = 'Extension: MẤT KẾT NỐI! Đang tải lại...';
            document.getElementById('ext-status').className = 'status disconnected';
            setTimeout(() => window.location.reload(), 3000);
        }
    }, 1000);
}, 5000);

// Xử lý các lệnh Button
document.getElementById('btn-2step').onclick = () => reqLink('/uptolink2step');
document.getElementById('btn-3step').onclick = () => reqLink('/uptolink3step');
document.getElementById('btn-withdraw').onclick = () => socket.emit('withdraw');

function reqLink(type) {
    socket.emit('request_link', {
        type,
        autoPP: document.getElementById('auto-pp').checked,
        delay: document.getElementById('delay-val').value
    });
}

// Lắng nghe Server
socket.on('new_link', (data) => {
    log(`Nhận link: ${data.url}`);
    // Đẩy link cho Extension mở tab
    window.postMessage({ type: 'OPEN_TASK_TAB', url: data.url, messageId: data.messageId }, '*');
    socket.emit('task_started', data);
});

socket.on('device_update', (devices) => {
    const list = document.getElementById('device-list');
    list.innerHTML = '';
    for(let id in devices) {
        list.innerHTML += `<li>IP: ${devices[id].ip} - Trạng thái: ${devices[id].status.toUpperCase()}</li>`;
    }
});

socket.on('alert', (data) => { alert(data.message); });

function log(msg) {
    const box = document.getElementById('logs');
    box.innerHTML += `<div>[${new Date().toLocaleTimeString()}] ${msg}</div>`;
    box.scrollTop = box.scrollHeight;
}
