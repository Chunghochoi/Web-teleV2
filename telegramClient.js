const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = YOUR_API_ID;
const apiHash = 'YOUR_API_HASH';
const session = new StringSession('YOUR_SAVED_SESSION');
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let withdrawState = 'IDLE'; // IDLE, WAIT_NAME, WAIT_AMOUNT
let withdrawAmount = 0;
let linkTasks = {}; // Lưu msgId của từng link để ấn nút "Kiểm tra hoàn thành"
let dailyLinks = 0;

async function initTelegram(io) {
    await client.connect();
    console.log("Đã kết nối Telegram Userbot: Chungdacoeim");

    client.addEventHandler(async (event) => {
        const message = event.message;
        if (message.peerId.userId?.toJSNumber() !== ID_CUA_BOT_CRYPTO) return;

        const text = message.message;

        // 1. Nhận Link từ /uptolink2step hoặc 3step
        if (message.replyMarkup) {
            const buttons = message.replyMarkup.rows[0]?.buttons;
            if (buttons && buttons[0].url) {
                const url = buttons[0].url;
                const msgId = message.id;
                linkTasks[url] = msgId; // Lưu msgId để click nút sau này
                io.emit("NEW_LINK_RECEIVED", { url, msgId });
                dailyLinks++;
                
                io.emit("UPDATE_LOG", `Nhận link mới, tổng: ${dailyLinks}`);
                if (dailyLinks % 50 === 0) client.sendMessage(message.chatId, { message: "/top" });
                if (dailyLinks === 30) client.sendMessage(message.chatId, { message: "/spin" });
                client.sendMessage(message.chatId, { message: "/view" });
            }
        }

        // 2. Logic /view
        if (text.includes("Số dư:") && text.includes("NV hôm nay:")) {
            const balanceRegex = /Số dư: (\d+)đ/;
            const taskRegex = /NV hôm nay: (\d+\/\d+)/;
            const balance = text.match(balanceRegex)?.[1] || "0";
            const tasks = text.match(taskRegex)?.[1] || "0/0";
            io.emit("UPDATE_STATS", { balance, tasks });
        }

        // 3. Logic /withdraw
        if (withdrawState === 'IDLE' && text.includes("Nhập tên ngân hàng")) {
            const balanceRegex = /Số dư: (\d+)đ/;
            withdrawAmount = text.match(balanceRegex)?.[1] || "0";
            await client.sendMessage(message.chatId, { message: "Momo" });
            withdrawState = 'WAIT_NAME';
        } 
        else if (withdrawState === 'WAIT_NAME' && text.includes("Nhập tên chủ tài khoản")) {
            await client.sendMessage(message.chatId, { message: "DANG VAN CHUNG" });
            withdrawState = 'WAIT_AMOUNT';
        }
        else if (withdrawState === 'WAIT_AMOUNT' && text.includes("Nhập số tiền muốn rút")) {
            await client.sendMessage(message.chatId, { message: withdrawAmount });
            withdrawState = 'IDLE';
        }
        else if (text.includes("Yêu cầu rút") && text.includes("đã được duyệt!")) {
            io.emit("WITHDRAW_SUCCESS", "Tiền về, Tiền về");
        }

        // 4. Báo cáo hoàn thành nhiệm vụ từ Admin
        if (text.includes("Admin đã duyệt nhiệm vụ của bạn!")) {
            io.emit("TASK_APPROVED", { text });
            // Nếu bật auto-pplink, hệ thống gửi lệnh lấy link tiếp theo ở logic Socket
        }
    }, new NewMessage({}));
}

// Hàm ấn nút "Kiểm tra hoàn thành" theo msgId
async function clickCheckCompletionButton(msgId) {
    // Lấy data của nút "Kiểm tra hoàn thành" (Thường là nút thứ 2 trong tin nhắn)
    const msgs = await client.getMessages(ID_CUA_BOT_CRYPTO, { ids: msgId });
    const buttonData = msgs[0].replyMarkup.rows[0]?.buttons[1]?.data; 
    await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer: ID_CUA_BOT_CRYPTO,
        msgId: msgId,
        data: buttonData
    }));
}
// ... (các setup thư viện giữ nguyên như phần trước) ...

// 1. Phần Lắng nghe tin nhắn mới từ Bot
client.addEventHandler(async (event) => {
    const message = event.message;
    if (message.peerId.userId?.toJSNumber() !== ID_CUA_BOT_CRYPTO) return;

    const text = message.message;

    // Bỏ qua tin nhắn "Đang tạo link..." không có nút bấm
    if (text.includes("Đang tạo link...")) return;

    // 2. Nhận Link từ tin nhắn có chứa nhiệm vụ (Dựa vào ảnh)
    if (message.replyMarkup && message.replyMarkup.rows.length >= 2) {
        // Lấy hàng 1 (rows[0]), nút 1 (buttons[0]) -> Nút "Mở link"
        const btnMoLink = message.replyMarkup.rows[0]?.buttons[0];
        
        if (btnMoLink && btnMoLink.url) {
            const url = btnMoLink.url;
            const msgId = message.id; // Lưu lại đúng ID của tin nhắn này
            
            linkTasks[url] = msgId; 
            dailyLinks++;
            
            console.log(`Đã lấy URL: ${url} từ MessageID: ${msgId}`);
            
            // Gửi qua Socket cho Extension mở web
            io.emit("NEW_LINK_RECEIVED", { url, msgId });
            io.emit("UPDATE_LOG", `Nhận link nhiệm vụ #${dailyLinks}`);

            // Logic tự động /top, /spin, /view như yêu cầu của bạn
            if (dailyLinks % 50 === 0) client.sendMessage(message.chatId, { message: "/top" });
            if (dailyLinks === 30) client.sendMessage(message.chatId, { message: "/spin" });
            client.sendMessage(message.chatId, { message: "/view" });
        }
    }

    // ... (Các logic /view, /withdraw, đọc số dư giữ nguyên như cũ) ...

}, new NewMessage({}));


// 3. Hàm ấn nút "Kiểm tra hoàn thành" (Đã fix theo ảnh)
async function clickCheckCompletionButton(msgId) {
    try {
        // Lấy lại tin nhắn dựa trên msgId đã lưu
        const msgs = await client.getMessages(ID_CUA_BOT_CRYPTO, { ids: msgId });
        if (!msgs || msgs.length === 0) return;

        const targetMessage = msgs[0];

        // Lấy hàng 2 (rows[1]), nút 1 (buttons[0]) -> Nút "Kiểm tra hoàn thành"
        const btnKiemTra = targetMessage.replyMarkup.rows[1]?.buttons[0];
        
        if (btnKiemTra && btnKiemTra.data) {
            // Thực hiện hành động click (Gửi callback query) ẩn dưới background
            await client.invoke(new Api.messages.GetBotCallbackAnswer({
                peer: ID_CUA_BOT_CRYPTO,
                msgId: msgId,
                data: btnKiemTra.data // Data mã hóa riêng của nút này
            }));
            console.log(`Đã ấn "Kiểm tra hoàn thành" cho tin nhắn ID: ${msgId}`);
        }
    } catch (error) {
        console.error("Lỗi khi ấn nút kiểm tra:", error);
    }
}