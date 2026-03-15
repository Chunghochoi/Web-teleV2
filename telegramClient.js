const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// Đọc biến môi trường (Đã bỏ BOT_ID)
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION_STRING || "");

// SỬ DỤNG TRỰC TIẾP USERNAME CỦA BOT ĐỂ TRÁNH LỖI ID
const BOT_USERNAME = "@CryptoMoney_Bot";
let botNumericId = null;

// Khởi tạo client Telegram
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

// --- CÁC BIẾN TRẠNG THÁI ---
let withdrawState = 'IDLE'; 
let withdrawAmount = "0";
let dailyLinks = 0;
let isPaused = false;
let currentCommand = '/uptolink2step';

async function initTelegram(io, distributeLinkCallback, getAutoStatus) {
    await client.connect();
    console.log("✅ Đã kết nối Telegram Userbot thành công!");

    try {
        // Tự động lấy ID dạng số của Bot để kiểm tra tin nhắn đến
        const botEntity = await client.getEntity(BOT_USERNAME);
        botNumericId = botEntity.id.toJSNumber();
        console.log(`✅ Đã nhận diện ID Bot: ${botNumericId}`);
    } catch (error) {
        console.log("⚠️ Cảnh báo: Chưa thể quét Bot. Hệ thống vẫn sẽ gửi lệnh.");
    }

    // Lắng nghe tin nhắn mới
    client.addEventHandler(async (event) => {
        const message = event.message;
        
        // Kiểm tra đúng tin nhắn từ Bot @CryptoMoney_Bot
        if (botNumericId && message.peerId.userId?.toJSNumber() !== botNumericId) return;

        const text = message.message || "";

        if (text.includes("Đang tạo link...")) return;

        // A. LUỒNG NHẬN LINK NHIỆM VỤ TỪ BOT
        if (message.replyMarkup && message.replyMarkup.rows.length >= 2) {
            const btnMoLink = message.replyMarkup.rows[0]?.buttons[0];
            
            if (btnMoLink && btnMoLink.url && !isPaused) {
                const url = btnMoLink.url;
                const msgId = message.id;
                
                dailyLinks++;
                io.emit("UPDATE_LOG", `[Hệ thống] Nhận link NV #${dailyLinks}. Đang tìm thiết bị rảnh...`);
                
                distributeLinkCallback(url, msgId);

                if (dailyLinks % 50 === 0) await client.sendMessage(BOT_USERNAME, { message: "/top" });
                if (dailyLinks === 30) await client.sendMessage(BOT_USERNAME, { message: "/spin" });
                await client.sendMessage(BOT_USERNAME, { message: "/view" });
            }
        }

        // B. LUỒNG LẤY THÔNG TIN CẬP NHẬT (/view)
        if (text.includes("Số dư:") && text.includes("NV hôm nay:")) {
            const balanceRegex = /Số dư: (\d+)đ/;
            const taskRegex = /NV hôm nay: (\d+\/\d+)/;
            const balance = text.match(balanceRegex)?.[1] || "0";
            const tasks = text.match(taskRegex)?.[1] || "0/0";
            io.emit("UPDATE_STATS", { balance, tasks });
        }

        // C. LUỒNG RÚT TIỀN TỰ ĐỘNG (/withdraw)
        if (withdrawState === 'IDLE' && text.includes("Nhập tên ngân hàng")) {
            const balanceRegex = /Số dư: (\d+)đ/;
            withdrawAmount = text.match(balanceRegex)?.[1] || "0";
            io.emit("UPDATE_LOG", `[Rút tiền] Đang yêu cầu rút về Momo...`);
            await client.sendMessage(BOT_USERNAME, { message: "Momo" });
            withdrawState = 'WAIT_NAME';
        } 
        else if (withdrawState === 'WAIT_NAME' && text.includes("Nhập tên chủ tài khoản")) {
            io.emit("UPDATE_LOG", `[Rút tiền] Đang nhập tên chủ TK...`);
            await client.sendMessage(BOT_USERNAME, { message: "DANG VAN CHUNG" });
            withdrawState = 'WAIT_AMOUNT';
        }
        else if (withdrawState === 'WAIT_AMOUNT' && text.includes("Nhập số tiền muốn rút")) {
            io.emit("UPDATE_LOG", `[Rút tiền] Đang gửi yêu cầu rút ${withdrawAmount}đ...`);
            await client.sendMessage(BOT_USERNAME, { message: withdrawAmount });
            withdrawState = 'IDLE';
        }
        else if (text.includes("Yêu cầu rút") && text.includes("đã gửi. Chờ admin duyệt")) {
            io.emit("UPDATE_LOG", `[Rút tiền] Hoàn tất lệnh. Chờ duyệt!`);
            isPaused = false; 
        }
        else if (text.includes("Yêu cầu rút") && text.includes("đã được duyệt!")) {
            io.emit("WITHDRAW_SUCCESS", "Tiền về, Tiền về");
        }

        // D. LUỒNG ADMIN DUYỆT NHIỆM VỤ -> CHẠY TIẾP AUTO
        if (text.includes("Admin đã duyệt nhiệm vụ của bạn!")) {
            io.emit("UPDATE_LOG", `[Thành công] Nhiệm vụ đã được duyệt! Đang gọi link tiếp...`);
            
            const isAutoOn = getAutoStatus();
            if (isAutoOn && !isPaused) {
                setTimeout(async () => {
                    await client.sendMessage(BOT_USERNAME, { message: currentCommand });
                }, 2000); 
            }
        }

    }, new NewMessage({}));
}

async function clickCheckCompletionButton(msgId, deviceIp, io) {
    try {
        io.emit("UPDATE_LOG", `[Thiết bị ${deviceIp}] Đang ấn nút báo cáo...`);
        const msgs = await client.getMessages(BOT_USERNAME, { ids: msgId });
        if (!msgs || msgs.length === 0) return;

        const btnKiemTra = msgs[0].replyMarkup?.rows[1]?.buttons[0];
        
        if (btnKiemTra && btnKiemTra.data) {
            await client.invoke(new Api.messages.GetBotCallbackAnswer({
                peer: BOT_USERNAME,
                msgId: msgId,
                data: btnKiemTra.data
            }));
            io.emit("UPDATE_LOG", `[Hệ thống] Đã báo cáo hoàn thành NV ID: ${msgId}`);
        }
    } catch (error) {
        console.error("Lỗi khi ấn nút kiểm tra:", error);
        io.emit("UPDATE_LOG", `[Lỗi] Không thể ấn báo cáo cho ID ${msgId}`);
    }
}

async function sendTelegramCommand(command, isWithdraw = false) {
    try {
        if (isWithdraw) {
            isPaused = true;
            withdrawState = 'IDLE';
        } else {
            isPaused = false;
            currentCommand = command; 
        }
        
        // Gửi lệnh thẳng vào username của bot
        await client.sendMessage(BOT_USERNAME, { message: command });
        console.log(`Đã gửi lệnh thành công: ${command}`);
        
    } catch (error) {
        console.error(`❌ Lỗi gửi lệnh ${command}:`, error);
    }
}

module.exports = {
    initTelegram,
    clickCheckCompletionButton,
    sendTelegramCommand
};
