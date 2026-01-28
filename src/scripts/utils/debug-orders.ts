import { ApiClient } from '../../services/api';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    const api = new ApiClient();
    await api.init();

    console.log(`-----------------------------------`);
    console.log(`Trader Address (Smart Wallet): ${api.getAddress()}`);
    console.log(`-----------------------------------`);

    console.log("Fetching open orders...");
    const orders = await api.getOpenOrders();
    console.log(`Found ${orders.length} orders.`);

    if (orders.length > 0) {
        // Log first order structure
        console.log("Sample Order:", JSON.stringify(orders[0], null, 2));

        // Filter my orders (Structure is { id: "...", order: { maker: "..." } })
        const myOrders = orders.filter((o: any) => o.order?.maker?.toLowerCase() === api.getAddress().toLowerCase());
        console.log(`My Orders: ${myOrders.length}`);

        if (myOrders.length > 0) {
            const ids = myOrders.map((o: any) => o.id);
            console.log("IDs to remove:", ids);

            // Try removing
            await api.removeOrders(ids);
        }
    }
}

main();
