const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION_STRING || "");

const BOT_USERNAME = "@CryptoMoney_Bot";
let botNumericId = null;

const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

let withdrawState = 'IDLE'; 
let withdrawAmount = "0";
let dailyLinks = 0;
let isPaused = false;

// Thêm callback onTaskApproved để báo cho server biết đã xong 1 NV
async function initTelegram(io, distributeLinkCallback, getAutoStatus, onTaskApproved) {
    await client.connect();
    console.log("✅ Đã kết nối Telegram Userbot thành công!");

    try {
        const botEntity = await client.getEntity(BOT_USERNAME);
        botNumericId = botEntity.id.toJSNumber();
    } catch (error) { console.log("⚠️ Cảnh báo: Chưa quét được ID Bot."); }

    client.addEventHandler(async (event) => {
        const message = event.message;
        if (botNumericId && message.peerId.userId?.toJSNumber() !== botNumericId) return;

        const text = message.message || "";
        if (text.includes("Đang tạo link...")) return;

        // A. NHẬN LINK
        if (message.replyMarkup && message.replyMarkup.rows.length > 0) {
            const btnMoLink = message.replyMarkup.rows[0]?.buttons[0];
            if (btnMoLink && btnMoLink.url && !isPaused) {
                const url = btnMoLink.url;
                const msgId = message.id;
                
                dailyLinks++;
                io.emit("UPDATE_LOG", `[Hệ thống] Nhận link NV #${dailyLinks}. Đang phân phối...`);
                distributeLinkCallback(url, msgId);

                if (dailyLinks % 50 === 0) await client.sendMessage(BOT_USERNAME, { message: "/top" });
                if (dailyLinks === 30) await client.sendMessage(BOT_USERNAME, { message: "/spin" });
                await client.sendMessage(BOT_USERNAME, { message: "/view" });
            }
        }

        // B. RÚT TIỀN
        if (withdrawState === 'IDLE' && text.includes("Nhập tên ngân hàng")) {
            withdrawAmount = text.match(/Số dư: (\d+)đ/)?.[1] || "0";
            await client.sendMessage(BOT_USERNAME, { message: "Momo" });
            withdrawState = 'WAIT_NAME';
        } else if (withdrawState === 'WAIT_NAME' && text.includes("Nhập tên chủ tài khoản")) {
            await client.sendMessage(BOT_USERNAME, { message: "DANG VAN CHUNG" });
            withdrawState = 'WAIT_AMOUNT';
        } else if (withdrawState === 'WAIT_AMOUNT' && text.includes("Nhập số tiền muốn rút")) {
            await client.sendMessage(BOT_USERNAME, { message: withdrawAmount });
            withdrawState = 'IDLE';
        } else if (text.includes("Yêu cầu rút") && text.includes("đã gửi")) {
            isPaused = false; 
        } else if (text.includes("đã được duyệt!")) {
            io.emit("WITHDRAW_SUCCESS", "Tiền về, Tiền về");
        }

        // C. DUYỆT NHIỆM VỤ -> BÁO SERVER ĐỂ TĂNG BỘ ĐẾM VÀ GỌI LINK TIẾP
        if (text.includes("Admin đã duyệt nhiệm vụ của bạn!")) {
            io.emit("UPDATE_LOG", `[Thành công] Nhiệm vụ đã được duyệt cộng tiền!`);
            onTaskApproved(); // Kích hoạt bộ đếm trên server
        }

    }, new NewMessage({}));
}

// FIX LỖI ẤN NÚT: Tìm nút động bằng cách quét chữ "Kiểm tra"
async function clickCheckCompletionButton(msgId, deviceIp, io) {
    try {
        io.emit("UPDATE_LOG", `[Thiết bị ${deviceIp}] Đang ấn nút Kiểm tra hoàn thành...`);
        const msgs = await client.getMessages(BOT_USERNAME, { ids: msgId });
        if (!msgs || msgs.length === 0) return;

        let targetData = null;
        
        // Quét toàn bộ các hàng và các nút để tìm đúng nút "Kiểm tra hoàn thành"
        for (const row of msgs[0].replyMarkup.rows) {
            for (const btn of row.buttons) {
                if (btn.text && btn.text.includes("Kiểm tra")) {
                    targetData = btn.data;
                    break;
                }
            }
            if (targetData) break;
        }

        if (targetData) {
            await client.invoke(new Api.messages.GetBotCallbackAnswer({
                peer: BOT_USERNAME,
                msgId: msgId,
                data: targetData
            }));
            io.emit("UPDATE_LOG", `[Hệ thống] Đã bấm nút Kiểm tra cho ID: ${msgId} thành công!`);
        } else {
            // Backup phòng trường hợp không lấy được text
            const backupBtn = msgs[0].replyMarkup?.rows[1]?.buttons[0];
            if (backupBtn && backupBtn.data) {
                await client.invoke(new Api.messages.GetBotCallbackAnswer({
                    peer: BOT_USERNAME, msgId: msgId, data: backupBtn.data
                }));
            }
        }
    } catch (error) {
        console.error("Lỗi ấn nút:", error);
    }
}

async function sendTelegramCommand(command, isWithdraw = false) {
    try {
        if (isWithdraw) { isPaused = true; withdrawState = 'IDLE'; } 
        else { isPaused = false; }
        await client.sendMessage(BOT_USERNAME, { message: command });
    } catch (error) { console.error(`❌ Lỗi gửi lệnh:`, error); }
}

module.exports = { initTelegram, clickCheckCompletionButton, sendTelegramCommand };
