const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// Đọc biến môi trường
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION_STRING || "");
const BOT_ID = parseInt(process.env.BOT_ID);

// Khởi tạo client Telegram
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

// --- CÁC BIẾN TRẠNG THÁI ---
let withdrawState = 'IDLE'; // IDLE, WAIT_NAME, WAIT_AMOUNT
let withdrawAmount = "0";
let dailyLinks = 0;
let isPaused = false;
let currentCommand = '/uptolink2step';

/**
 * Hàm Khởi tạo Telegram Client và Lắng nghe sự kiện
 * @param {Object} io - Đối tượng Socket.io để gửi Real-time lên Web UI
 * @param {Function} distributeLinkCallback - Hàm gọi ngược lại server.js để chia link cho thiết bị
 * @param {Function} getAutoStatus - Hàm kiểm tra xem Auto-PPLink trên Web đang BẬT hay TẮT
 */
async function initTelegram(io, distributeLinkCallback, getAutoStatus) {
    await client.connect();
    console.log("✅ Đã kết nối Telegram Userbot thành công!");

    // Lắng nghe tin nhắn mới
    client.addEventHandler(async (event) => {
        const message = event.message;
        
        // Bỏ qua nếu không phải tin nhắn từ Bot Crypto
        if (message.peerId.userId?.toJSNumber() !== BOT_ID) return;

        const text = message.message || "";

        // Bỏ qua tin nhắn trung gian không có nút
        if (text.includes("Đang tạo link...")) return;

        // ==========================================
        // A. LUỒNG NHẬN LINK NHIỆM VỤ TỪ BOT
        // ==========================================
        if (message.replyMarkup && message.replyMarkup.rows.length >= 2) {
            const btnMoLink = message.replyMarkup.rows[0]?.buttons[0];
            
            if (btnMoLink && btnMoLink.url && !isPaused) {
                const url = btnMoLink.url;
                const msgId = message.id;
                
                dailyLinks++;
                io.emit("UPDATE_LOG", `[Hệ thống] Nhận link NV #${dailyLinks}. Đang tìm thiết bị rảnh...`);
                
                // Gọi hàm bên server.js để chia link cho máy tính
                distributeLinkCallback(url, msgId);

                // Tự động kiểm tra mốc để gửi lệnh phụ
                if (dailyLinks % 50 === 0) await client.sendMessage(BOT_ID, { message: "/top" });
                if (dailyLinks === 30) await client.sendMessage(BOT_ID, { message: "/spin" });
                await client.sendMessage(BOT_ID, { message: "/view" });
            }
        }

        // ==========================================
        // B. LUỒNG LẤY THÔNG TIN CẬP NHẬT (/view)
        // ==========================================
        if (text.includes("Số dư:") && text.includes("NV hôm nay:")) {
            const balanceRegex = /Số dư: (\d+)đ/;
            const taskRegex = /NV hôm nay: (\d+\/\d+)/;
            const balance = text.match(balanceRegex)?.[1] || "0";
            const tasks = text.match(taskRegex)?.[1] || "0/0";
            io.emit("UPDATE_STATS", { balance, tasks });
        }

        // ==========================================
        // C. LUỒNG RÚT TIỀN TỰ ĐỘNG (/withdraw)
        // ==========================================
        if (withdrawState === 'IDLE' && text.includes("Nhập tên ngân hàng")) {
            const balanceRegex = /Số dư: (\d+)đ/;
            withdrawAmount = text.match(balanceRegex)?.[1] || "0";
            io.emit("UPDATE_LOG", `[Rút tiền] Đang yêu cầu rút về Momo...`);
            await client.sendMessage(BOT_ID, { message: "Momo" });
            withdrawState = 'WAIT_NAME';
        } 
        else if (withdrawState === 'WAIT_NAME' && text.includes("Nhập tên chủ tài khoản")) {
            io.emit("UPDATE_LOG", `[Rút tiền] Đang nhập tên chủ TK...`);
            await client.sendMessage(BOT_ID, { message: "DANG VAN CHUNG" });
            withdrawState = 'WAIT_AMOUNT';
        }
        else if (withdrawState === 'WAIT_AMOUNT' && text.includes("Nhập số tiền muốn rút")) {
            io.emit("UPDATE_LOG", `[Rút tiền] Đang gửi yêu cầu rút ${withdrawAmount}đ...`);
            await client.sendMessage(BOT_ID, { message: withdrawAmount });
            withdrawState = 'IDLE';
        }
        else if (text.includes("Yêu cầu rút") && text.includes("đã gửi. Chờ admin duyệt")) {
            io.emit("UPDATE_LOG", `[Rút tiền] Hoàn tất lệnh. Chờ duyệt!`);
            isPaused = false; // Xong luồng rút tiền, nhả cờ Pause
        }
        else if (text.includes("Yêu cầu rút") && text.includes("đã được duyệt!")) {
            io.emit("WITHDRAW_SUCCESS", "Tiền về, Tiền về");
        }

        // ==========================================
        // D. LUỒNG ADMIN DUYỆT NHIỆM VỤ -> CHẠY TIẾP AUTO
        // ==========================================
        if (text.includes("Admin đã duyệt nhiệm vụ của bạn!")) {
            io.emit("UPDATE_LOG", `[Thành công] Nhiệm vụ đã được duyệt cộng tiền!`);
            
            // Lấy trạng thái xem Web có đang bật nút Auto không
            const isAutoOn = getAutoStatus();
            if (isAutoOn && !isPaused) {
                setTimeout(async () => {
                    await client.sendMessage(BOT_ID, { message: currentCommand });
                }, 2000); // Tránh bị spam quá nhanh
            }
        }

    }, new NewMessage({}));
}

/**
 * Hàm Gọi API Telegram để click nút "Kiểm tra hoàn thành"
 */
async function clickCheckCompletionButton(msgId, deviceIp, io) {
    try {
        io.emit("UPDATE_LOG", `[Thiết bị ${deviceIp}] Báo cáo hoàn thành. Đang ấn nút kiểm tra...`);
        const msgs = await client.getMessages(BOT_ID, { ids: msgId });
        if (!msgs || msgs.length === 0) return;

        // Lấy hàng 2 (rows[1]), nút 1 -> Nút "Kiểm tra hoàn thành"
        const btnKiemTra = msgs[0].replyMarkup?.rows[1]?.buttons[0];
        
        if (btnKiemTra && btnKiemTra.data) {
            await client.invoke(new Api.messages.GetBotCallbackAnswer({
                peer: BOT_ID,
                msgId: msgId,
                data: btnKiemTra.data
            }));
            io.emit("UPDATE_LOG", `[Hệ thống] Đã ấn nút thành công cho Message ID: ${msgId}`);
        }
    } catch (error) {
        console.error("Lỗi khi ấn nút kiểm tra:", error);
        io.emit("UPDATE_LOG", `[Lỗi] Không thể ấn kiểm tra cho ID ${msgId}`);
    }
}

/**
 * Hàm gửi lệnh từ Web UI cho Bot (Ví dụ: /withdraw, /uptolink2step, ...)
 */
async function sendTelegramCommand(command, isWithdraw = false) {
    if (isWithdraw) {
        isPaused = true;
        withdrawState = 'IDLE';
    } else {
        isPaused = false;
        currentCommand = command; // Lưu lại lệnh để tự động lặp lại
    }
    await client.sendMessage(BOT_ID, { message: command });
}

// Xuất các module để server.js có thể sử dụng
module.exports = {
    initTelegram,
    clickCheckCompletionButton,
    sendTelegramCommand
};