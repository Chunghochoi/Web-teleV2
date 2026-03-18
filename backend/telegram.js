const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = 1234567; // THAY BẰNG API ID CỦA BẠN
const apiHash = "YOUR_API_HASH"; // THAY BẰNG API HASH
const stringSession = new StringSession("YOUR_SESSION_STRING_HERE");
const BOT_USERNAME = "CryptoMoney_Bot";

let client;
let isWithdrawing = false;
let withdrawStep = 0;

async function initTelegram(io) {
    client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    console.log("[GramJS] Connected as Chungdacoeim");

    client.addEventHandler(async (update) => {
        if (update.message && update.message.peerId) {
            const sender = await client.getEntity(update.message.peerId);
            if (sender.username === BOT_USERNAME) {
                const text = update.message.message;
                const messageId = update.message.id;

                // 1. LUỒNG RÚT TIỀN (Priority 1)
                if (isWithdrawing) {
                    if (text.includes("Bank")) {
                        await client.sendMessage(BOT_USERNAME, { message: "Momo" });
                    } else if (text.includes("Tên")) {
                        await client.sendMessage(BOT_USERNAME, { message: "DANG VAN CHUNG\n0389511642" });
                    } else if (text.includes("Số dư:")) {
                        // Trích xuất số tiền: "Số dư: 20168 đ" -> 20168
                        const match = text.match(/Số dư:\s*(\d+)\s*đ/);
                        if (match) await client.sendMessage(BOT_USERNAME, { message: match[1] });
                    } else if (text.includes("đã được duyệt")) {
                        io.emit("alert", { message: "Tiền về, Tiền về!", type: "success" });
                        isWithdrawing = false;
                    }
                    return;
                }

                // 2. LUỒNG LẤY LINK (Lấy URL từ Nút Bấm)
                if (update.message.replyMarkup && update.message.replyMarkup.rows) {
                    for (const row of update.message.replyMarkup.rows) {
                        for (const button of row.buttons) {
                            if (button.url) {
                                io.emit("new_link", { url: button.url, messageId: messageId });
                            }
                        }
                    }
                }

                // 3. LUỒNG XEM SỐ DƯ (/view)
                if (text.includes("Số dư:") && text.includes("NV hôm nay:")) {
                    io.emit("balance_update", { text: text });
                }
            }
        }
    }, new Api.events.NewMessage({}));
}

// Hàm gửi lệnh cơ bản
async function sendCommand(command) {
    if (isWithdrawing) return;
    await client.sendMessage(BOT_USERNAME, { message: command });
}

// Bấm nút "Kiểm tra hoàn thành"
async function checkTaskCompletion(messageId, io) {
    try {
        const result = await client.invoke(new Api.messages.GetBotCallbackAnswer({
            peer: BOT_USERNAME,
            msgId: messageId,
            data: Buffer.from("check_done") // Giả định data của callback, cần debug Telegram để lấy chính xác byte
        }));
        if (result.message && result.message.includes("Admin đã duyệt nhiệm vụ")) {
            io.emit("task_success", { message: result.message });
        }
    } catch (e) {
        console.log("[Telegram] Lỗi check completion:", e);
    }
}

// Trigger luồng rút tiền
function triggerWithdraw() {
    isWithdrawing = true;
    sendCommand("/withdraw");
}

module.exports = { initTelegram, sendCommand, checkTaskCompletion, triggerWithdraw };