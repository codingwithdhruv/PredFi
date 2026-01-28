
import { Contract, JsonRpcProvider } from 'ethers';
import { ApiClient } from '../../services/api';
import { AddressesByChainId, ChainId } from '@predictdotfun/sdk';
import { CONFIG } from '../../config';

const ERC20_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)"
];

async function checkApprovals() {
    const api = new ApiClient();
    try {
        const provider = new JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
        const addresses = AddressesByChainId[CONFIG.CHAIN_ID as ChainId];
        const owner = api.getTraderAddress();

        console.log(`Checking allowances for Owner (Trader): ${owner}...`);
        console.log(`Using Signer: ${api.getSignerAddress()}`);

        const usdt = new Contract(addresses.USDT, ERC20_ABI, provider);

        // Check CTF Exchange
        const allow1 = await usdt.allowance(owner, addresses.CTF_EXCHANGE);
        console.log(`USDT -> CTF Exchange Allowance: ${allow1.toString()}`);

        // Check Yield Bearing CTF Exchange
        const allow2 = await usdt.allowance(owner, addresses.YIELD_BEARING_CTF_EXCHANGE);
        console.log(`USDT -> YB CTF Exchange Allowance: ${allow2.toString()}`);

    } catch (error: any) {
        console.error("Failed to check approvals:", error.message);
    }
}
checkApprovals();
