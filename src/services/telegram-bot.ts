import { Bot } from 'grammy';
import { CONFIG } from '../config';
import { ApiClient } from './api';
import { formatUnits } from 'ethers';

// Helper to format currency
const formatUsd = (val: string | number) => {
    const num = typeof val === 'string' ? parseFloat(val) : val;
    // Ensure strict escaping of the dot in the formatted string (e.g. $12.34 -> $12\.34)
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num).replace(/\./g, '\\.');
};

// Utility to escape MarkdownV2 special chars
function escapeMarkdown(text: string): string {
    if (!text) return "";
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

export function startTelegramBot(client: ApiClient) {
    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
        console.warn("⚠️ Telegram Bot Token not set. Skiping Bot startup.");
        return;
    }

    const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

    // Middleware to restrict access to allowed users
    bot.use(async (ctx, next) => {
        // If ALLOWED_USER_IDS is set (array checking), check it
        if (CONFIG.ALLOWED_USER_IDS && CONFIG.ALLOWED_USER_IDS.length > 0) {
            if (!ctx.from || !CONFIG.ALLOWED_USER_IDS.includes(ctx.from.id)) {
                console.warn(`Unauthorized access attempt from ${ctx.from?.id} (${ctx.from?.username})`);
                return;
            }
        }
        await next();
    });

    bot.command('start', async (ctx) => {
        await ctx.reply(
            "👋 *Welcome to Predict\\.fun Tracker\\!* \n\n" +
            "Use /stats to view your wallet performance\\.\n" +
            "Use /balance for wallet balance\\.\n" +
            "Use /positions for active positions\\.\n" +
            "Use /orders for open orders\\.\n" +
            "Use /activity for recent activity\\.",
            { parse_mode: "MarkdownV2" }
        );
    });

    bot.command('balance', async (ctx) => {
        const loader = await ctx.reply("🔄 Fetching balance...");
        try {
            const balance = await client.getUSDTBalance();
            await ctx.api.editMessageText(ctx.chat.id, loader.message_id,
                `💰 *Wallet Balance*\n\n` +
                `*USDT*: \`${escapeMarkdown(balance)}\``,
                { parse_mode: "MarkdownV2" }
            );
        } catch (e) {
            console.error(e);
            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "❌ Failed to fetch balance.");
        }
    });

    bot.command('positions', async (ctx) => {
        const loader = await ctx.reply("🔄 Fetching positions...");
        try {
            const positions = await client.getPositions();

            if (positions.length === 0) {
                await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "📉 No active positions found.");
                return;
            }

            let msg = "📋 *Active Positions*\n\n";
            for (const pos of positions) {
                // Parse raw position data from API
                const marketTitle = pos.market?.title || "Unknown Market";
                const outcomeName = pos.outcome?.name || "Unknown";
                const amountRaw = pos.amount || "0";
                const amount = parseFloat(formatUnits(amountRaw, 18)).toFixed(2);
                const valueUsd = pos.valueUsd || "0";
                const pnl = pos.pnl || "0";

                msg += `*${escapeMarkdown(marketTitle)}*\n`;
                msg += `Predict: ${escapeMarkdown(outcomeName)} | Amt: ${escapeMarkdown(amount)}\n`;
                msg += `Value: ${formatUsd(valueUsd)}`;
                if (pnl) {
                    const pnlVal = parseFloat(pnl);
                    const pnlStr = formatUsd(pnl);
                    const emoji = pnlVal >= 0 ? "🟢" : "🔴";
                    msg += ` | PnL: ${emoji} ${pnlStr}`;
                }
                msg += `\n\n`;
            }

            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, msg, { parse_mode: "MarkdownV2" });
        } catch (e) {
            console.error(e);
            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "❌ Failed to fetch positions.");
        }
    });

    bot.command('orders', async (ctx) => {
        const loader = await ctx.reply("🔄 Fetching open orders...");
        try {
            const orders = await client.getOpenOrders();

            if (orders.length === 0) {
                await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "📭 No open orders found.");
                return;
            }

            let msg = "📝 *Open Orders*\n\n";
            for (const orderItem of orders) {
                const ord = orderItem.order || orderItem;
                const mkt = orderItem.market || {};
                const out = orderItem.outcome || {};

                const side = (ord.quoteType === 'Bid' || ord.side === 'BUY') ? '🟢 Buy' : '🔴 Sell';
                const title = mkt.title || "Unknown Market";
                const outcomeName = out.name || "Unknown";

                // Amount and Price are in WEI (1e18)
                const priceWei = ord.price || ord.pricePerShare || "0";
                const amountWei = ord.amount || ord.makerAmount || "0";

                // Convert from Wei
                const priceVal = parseFloat(formatUnits(priceWei, 18));
                const amountVal = parseFloat(formatUnits(amountWei, 18));

                msg += `*${escapeMarkdown(title)}*\n`;
                msg += `${side} ${escapeMarkdown(outcomeName)} @ ${formatUsd(priceVal)}\n`;
                msg += `Amount: ${escapeMarkdown(amountVal.toFixed(2))}\n\n`;
            }

            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, msg, { parse_mode: "MarkdownV2" });
        } catch (e) {
            console.error(e);
            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "❌ Failed to fetch orders.");
        }
    });

    bot.command('activity', async (ctx) => {
        const loader = await ctx.reply("🔄 Fetching activity...");
        try {
            const activities = await client.getActivity(5);

            if (activities.length === 0) {
                await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "📭 No recent activity found.");
                return;
            }

            let msg = "📜 *Recent Activity*\n\n";
            for (const act of activities) {
                const type = act.type || "UNKNOWN";
                const date = new Date(act.createdAt).toLocaleDateString();

                msg += `*${escapeMarkdown(type)}* \\(${escapeMarkdown(date)}\\)\n`;
                if (act.market && act.market.title) {
                    msg += `Market: ${escapeMarkdown(act.market.title.substring(0, 30))}...\n`;
                }
                if (act.valueUsd) {
                    msg += `Value: ${formatUsd(act.valueUsd)}\n`;
                }
                msg += `\n`;
            }

            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, msg, { parse_mode: "MarkdownV2" });
        } catch (e) {
            console.error(e);
            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "❌ Failed to fetch activity.");
        }
    });

    bot.command('stats', async (ctx) => {
        const loader = await ctx.reply("🔄 Fetching dashboard...");
        try {
            const [balance, positions, openOrders, volume, accountInfo] = await Promise.all([
                client.getUSDTBalance(),
                client.getPositions(),
                client.getOpenOrders(),
                client.getVolumeStats(),
                client.getAccount()
            ]);

            // Detect if API key is missing from config
            const isApiKeyMissing = !CONFIG.API_KEY || CONFIG.API_KEY.trim().length === 0;

            const totalPosValue = positions.reduce((acc: number, p: any) => acc + parseFloat(p.valueUsd || '0'), 0);
            const totalPnl = positions.reduce((acc: number, p: any) => acc + parseFloat(p.pnl || '0'), 0);
            const activeCount = positions.length;
            const ordersCount = openOrders.length;
            const walletBalance = parseFloat(balance);
            const portfolioValue = walletBalance + totalPosValue;

            const points = (accountInfo as any).points || 0;

            let msg = "📊 *Predict\\.fun Dashboard*\n\n";
            msg += `💰 *Portfolio Value*: \`${formatUsd(portfolioValue)}\`\n`;
            msg += `💵 *Wallet USDT*: \`${escapeMarkdown(balance)}\`\n`;
            msg += `🏆 *Total Points*: ${points}\n`;
            msg += `📊 *Volume \\(24h\\)*: \`${formatUsd(volume.today)}\`\n`;
            msg += `📅 *Volume \\(7d\\)*: \`${formatUsd(volume.week)}\`\n`;
            msg += `\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\n`;
            msg += `🎲 *Active Positions*: ${activeCount}\n`;
            msg += `📝 *Open Orders*: ${ordersCount}\n`;
            msg += `📈 *Positions Value*: \`${formatUsd(totalPosValue)}\`\n`;

            if (isApiKeyMissing) {
                msg += `⚠️ *Note*: Add \`API_KEY\` to enable full dashboard (positions, orders, etc.)\n`;
            } else if (totalPnl !== 0) {
                const emoji = totalPnl >= 0 ? "🟢" : "🔴";
                msg += `🔥 *Total PnL*: ${emoji} \`${formatUsd(totalPnl)}\`\n`;
            }

            msg += `\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\n`;

            if (activeCount > 0) {
                msg += `\n*Top Positions:*\n`;
                for (const pos of positions.slice(0, 3)) {
                    const marketTitle = pos.market?.title || "Unknown";
                    const outcomeName = pos.outcome?.name || "Unknown";
                    const valueUsd = pos.valueUsd || "0";
                    const pnl = pos.pnl || "0";

                    const title = marketTitle.length > 25 ? marketTitle.substring(0, 25) + '...' : marketTitle;
                    msg += `• ${escapeMarkdown(title)} \\(${escapeMarkdown(outcomeName)}\\) : ${formatUsd(valueUsd)}`;
                    if (pnl) {
                        const pnlVal = parseFloat(pnl);
                        const emoji = pnlVal >= 0 ? "🟢" : "🔴";
                        msg += ` \\(${emoji}${formatUsd(pnl)}\\)`;
                    }
                    msg += `\n`;
                }
            }

            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, msg, { parse_mode: "MarkdownV2" });

        } catch (e) {
            console.error(e);
            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "❌ Failed to load dashboard.");
        }
    });

    bot.start();
    console.log("🤖 Telegram Bot Started.");
}
