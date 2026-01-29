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

// Plain format for code blocks
const formatUsdPlain = (val: string | number) => {
    const num = typeof val === 'string' ? parseFloat(val) : val;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
};

// Utility to escape MarkdownV2 special chars
export function escapeMarkdown(text: string | number | undefined | null): string {
    if (text === undefined || text === null) return "";
    const str = String(text);
    // Reserved characters in MarkdownV2: _ * [ ] ( ) ~ ` > # + - = | { } . !
    // We must escape them with a backslash.
    return str.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

let botInstance: Bot | null = null;

export function sendAlert(message: string) {
    if (!botInstance || !CONFIG.TELEGRAM_BOT_TOKEN) return;
    if (!CONFIG.ALLOWED_USER_IDS || CONFIG.ALLOWED_USER_IDS.length === 0) return;

    for (const userId of CONFIG.ALLOWED_USER_IDS) {
        botInstance.api.sendMessage(userId, message, { parse_mode: 'MarkdownV2' }).catch(e => {
            console.error(`[Telegram] Alert failed for ${userId}:`, e.message);
        });
    }
}

export function startTelegramBot(client: ApiClient) {
    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
        console.warn("⚠️ Telegram Bot Token not set. Skiping Bot startup.");
        return;
    }

    const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);
    botInstance = bot;

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
            const orders = await client.getEnrichedOpenOrders();
            if (orders.length === 0) {
                await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "📭 No open orders found.");
                return;
            }

            // Slice to avoid hitting Telegram limits
            const displayOrders = orders.slice(0, 10);

            let msg = "📝 *Open Orders*\n\n";
            for (const orderItem of displayOrders) {
                const ord = orderItem.order || orderItem;
                const mkt = orderItem.market || {};
                const out = orderItem.outcome || {};
                const sideText = ord.side === 0 ? '🟢 Buy' : '🔴 Sell';

                // Market ID followed by question
                const mktId = orderItem.marketId || ord.marketId || mkt.id || '???';
                const qText = mkt.question || mkt.title || "Unknown Market";
                const title = `Market #${mktId}: ${qText}`;

                const outcomeName = out.name || "Unknown";

                // Calculate Price from Maker/Taker Amounts
                const makerAmt = parseFloat(formatUnits(ord.makerAmount || "0", 18));
                const takerAmt = parseFloat(formatUnits(ord.takerAmount || "0", 18));
                let priceVal = 0;

                if (ord.side === 0) { // BUY
                    priceVal = takerAmt > 0 ? makerAmt / takerAmt : 0;
                } else { // SELL
                    priceVal = makerAmt > 0 ? takerAmt / makerAmt : 0;
                }

                const amountVal = ord.side === 0 ? takerAmt : makerAmt;
                const priceStr = priceVal < 0.01 ? priceVal.toPrecision(2) : priceVal.toFixed(2);

                msg += `*${escapeMarkdown(title)}*\n`;
                msg += `${sideText} ${escapeMarkdown(outcomeName)} @ $${escapeMarkdown(priceStr)}\n`;
                msg += `Amount: ${escapeMarkdown(amountVal.toFixed(2))} Shares\n\n`;
            }

            console.log(`[Telegram] Sending Orders Message (Length: ${msg.length})`);
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

            // Slice to max 5 items to prevent MESSAGE_TOO_LONG
            const recent = activities.slice(0, 5);

            let msg = "📜 *Recent Activity*\n\n";
            for (const act of recent) {
                const type = act.name || act.type || "UNKNOWN";
                const date = new Date(act.createdAt).toLocaleDateString();

                msg += `*${escapeMarkdown(type)}* \\(${escapeMarkdown(date)}\\)\n`;
                if (act.market && (act.market.id || act.market.title || act.market.question)) {
                    const mktId = act.market.id || act.marketId || '???';
                    const mTitle = act.market.question || act.market.title || "Unknown";
                    // Fix: Escape the whole line including the # character
                    msg += `${escapeMarkdown(`Market #${mktId}: ${mTitle.substring(0, 30)}...`)}\n`;
                }
                if (act.valueUsd) {
                    msg += `Value: ${formatUsd(act.valueUsd)}\n`;
                }
                msg += `\n`;
            }

            console.log(`[Telegram] Sending Activity Message (Length: ${msg.length})`);
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

            // Truncate balance for cleaner output
            const walletBalance = parseFloat(balance);
            const balanceStr = walletBalance.toFixed(2);

            const portfolioValue = walletBalance + totalPosValue;

            const points = (accountInfo as any).points || 0;

            let msg = "📊 *Predict\\.fun Dashboard*\n\n";
            msg += `💰 *Portfolio Value*: \`${formatUsdPlain(portfolioValue)}\`\n`;
            msg += `💵 *Wallet USDT*: \`${escapeMarkdown(balanceStr)}\`\n`;
            msg += `🏆 *Total Points*: ${points}\n`;
            msg += `📊 *Volume \\(24h\\)*: \`${formatUsdPlain(volume.today)}\`\n`;
            msg += `📅 *Volume \\(7d\\)*: \`${formatUsdPlain(volume.week)}\`\n`;
            msg += `\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\n`;
            msg += `🎲 *Active Positions*: ${activeCount}\n`;
            msg += `📝 *Open Orders*: ${ordersCount}\n`;
            msg += `📈 *Positions Value*: \`${formatUsdPlain(totalPosValue)}\`\n`;

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
                    const marketTitle = pos.market?.question || pos.market?.title || "Unknown";
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

    bot.command('search', async (ctx) => {
        const query = ctx.message?.text?.split(' ').slice(1).join(' ');
        if (!query) {
            await ctx.reply("🔍 *Usage*: /search <market question>\n\nExample: `/search Number of CZ tweets`", { parse_mode: "MarkdownV2" });
            return;
        }

        const loader = await ctx.reply("🔍 Searching for markets...");
        try {
            const groups = await client.searchMarkets(query);

            if (!groups || groups.length === 0) {
                await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "❌ No matching markets found.");
                return;
            }

            let msg = `🔍 *Search Results for "${escapeMarkdown(query.substring(0, 30))}"*\n\n`;

            // Limit to top 5 groups
            for (const group of groups.slice(0, 5)) {
                // Fetch full category info for a better title if possible
                const catInfo = await client.getCategory(group.slug);
                const categoryTitle = catInfo?.title || group.title;

                msg += `*${escapeMarkdown(categoryTitle)}*\n`;

                for (const mkt of group.markets) {
                    // Try to clean up the market title by removing the category title prefix/suffix
                    let mktTitle = mkt.question || mkt.title || "Unknown";

                    // Simple cleaning: if category title is "Foo", and market is "Yes - Foo", just show "Yes"
                    if (categoryTitle && mktTitle.toLowerCase().includes(categoryTitle.toLowerCase())) {
                        const cleaned = mktTitle.replace(new RegExp(categoryTitle, 'gi'), '').trim();
                        // If cleaned is something like " - " or " : ", strip it
                        const finalCleaned = cleaned.replace(/^[\s\-:]+|[\s\-:]+$/g, '');
                        if (finalCleaned) mktTitle = finalCleaned;
                    }

                    msg += `  • ${escapeMarkdown(mktTitle)} \\(ID: \`${escapeMarkdown(mkt.id)}\`\\)\n`;
                }
                msg += `\n`;
            }

            if (groups.length > 5) {
                msg += `_${escapeMarkdown(`...and ${groups.length - 5} more categories found`)}_`;
            }

            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, msg, { parse_mode: "MarkdownV2" });
        } catch (e) {
            console.error(e);
            await ctx.api.editMessageText(ctx.chat.id, loader.message_id, "❌ Failed to search markets.");
        }
    });

    bot.start();
    console.log("🤖 Telegram Bot Started.");
}
