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

async function initTelegram(io, distributeLinkCallback, getAutoStatus, onTaskApproved) {
    await client.connect();
    console.log("✅ Đã kết nối Telegram Userbot!");

    try {
        const botEntity = await client.getEntity(BOT_USERNAME);
        botNumericId = botEntity.id.toJSNumber();
    } catch (error) {}

    client.addEventHandler(async (event) => {
        const message = event.message;
        if (botNumericId && message.peerId.userId?.toJSNumber() !== botNumericId) return;

        const text = message.message || "";
        if (text.includes("Đang tạo link...")) return;

        // 1. LIÊN TỤC CẬP NHẬT SỐ DƯ REALTIME BẤT CỨ KHI NÀO BOT NHẮN
        let balMatch = text.match(/Số dư:\s*([\d,.]+)/i);
        if (balMatch) {
            io.emit("UPDATE_BALANCE", balMatch[1].replace(/,/g, ''));
        }

        // 2. BẮT THỨ HẠNG (/TOP)
        let rankMatch = text.match(/(Hạng của bạn|Thứ hạng|Hạng):\s*(\d+)/i);
        if (rankMatch) {
            io.emit("UPDATE_RANK", rankMatch[2]);
        }

        // 3. NHẬN LINK
        if (message.replyMarkup && message.replyMarkup.rows.length > 0) {
            const btnMoLink = message.replyMarkup.rows[0]?.buttons[0];
            if (btnMoLink && btnMoLink.url && !isPaused) {
                const url = btnMoLink.url;
                const msgId = message.id;
                
                dailyLinks++;
                io.emit("UPDATE_LOG", `[Hệ thống] Nhận link NV #${dailyLinks}. Đang phân phối...`);
                distributeLinkCallback(url, msgId);

                // Auto kiểm tra nếu đủ mốc
                if (dailyLinks % 50 === 0) await client.sendMessage(BOT_USERNAME, { message: "/top" });
                if (dailyLinks === 30) await client.sendMessage(BOT_USERNAME, { message: "/spin" });
            }
        }

        // 4. RÚT TIỀN MOMO
        if (withdrawState === 'IDLE' && text.includes("Nhập tên ngân hàng")) {
            withdrawAmount = balMatch ? balMatch[1] : "0";
            await client.sendMessage(BOT_USERNAME, { message: "Momo" });
            withdrawState = 'WAIT_ACCOUNT_NUMBER'; 
        } 
        else if (withdrawState === 'WAIT_ACCOUNT_NUMBER' && text.includes("Nhập số tài khoản")) {
            await client.sendMessage(BOT_USERNAME, { message: "0389511642" });
            withdrawState = 'WAIT_NAME';
        }
        else if (withdrawState === 'WAIT_NAME' && text.includes("Nhập tên chủ tài khoản")) {
            await client.sendMessage(BOT_USERNAME, { message: "DANG VAN CHUNG" });
            withdrawState = 'WAIT_AMOUNT';
        } 
        else if (withdrawState === 'WAIT_AMOUNT' && text.includes("Nhập số tiền muốn rút")) {
            await client.sendMessage(BOT_USERNAME, { message: withdrawAmount.replace(/,/g,'') });
            withdrawState = 'IDLE'; 
        } 
        else if (text.includes("Yêu cầu rút") && text.includes("đã gửi")) {
            isPaused = false; 
        } else if (text.includes("đã được duyệt!")) {
            io.emit("WITHDRAW_SUCCESS", "Tiền về, Tiền về");
        }

        // 5. DUYỆT NHIỆM VỤ
        if (text.includes("Admin đã duyệt nhiệm vụ của bạn!")) {
            io.emit("UPDATE_LOG", `[Thành công] Nhiệm vụ đã duyệt!`);
            onTaskApproved();
        }

    }, new NewMessage({}));
}

async function clickCheckCompletionButton(msgId, deviceIp, io) {
    try {
        io.emit("UPDATE_LOG", `[IP: ${deviceIp}] Bấm "Kiểm tra hoàn thành"...`);
        const msgs = await client.getMessages(BOT_USERNAME, { ids: msgId });
        if (!msgs || msgs.length === 0) return;

        let targetData = null;
        for (const row of msgs[0].replyMarkup.rows) {
            for (const btn of row.buttons) {
                if (btn.text && btn.text.includes("Kiểm tra")) { targetData = btn.data; break; }
            }
            if (targetData) break;
        }

        if (targetData) {
            await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: BOT_USERNAME, msgId: msgId, data: targetData }));
        } else {
            const backupBtn = msgs[0].replyMarkup?.rows[1]?.buttons[0];
            if (backupBtn && backupBtn.data) {
                await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: BOT_USERNAME, msgId: msgId, data: backupBtn.data }));
            }
        }
    } catch (e) { console.error("Lỗi ấn nút:", e); }
}

async function sendTelegramCommand(command, isWithdraw = false) {
    try {
        if (isWithdraw) { isPaused = true; withdrawState = 'IDLE'; } else { isPaused = false; }
        await client.sendMessage(BOT_USERNAME, { message: command });
    } catch (e) {}
}

module.exports = { initTelegram, clickCheckCompletionButton, sendTelegramCommand };
