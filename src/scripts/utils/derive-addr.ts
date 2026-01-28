import { ethers } from 'ethers';
import { CONFIG } from '../../config';

async function main() {
    const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
    const factoryAddr = "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D"; // From Constants.ts (KERNEL)
    const validatorAddr = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57"; // From Constants.ts
    const owner = CONFIG.PRIVATE_KEY ? new ethers.Wallet(CONFIG.PRIVATE_KEY).address : "";

    console.log(`EOA: ${owner}`);
    console.log(`Factory: ${factoryAddr}`);
    console.log(`Validator: ${validatorAddr}`);

    // Kernel Factory ABI v3.1 (Guessing standard methods)
    const abi = [
        "function getAccountAddress(address validator, bytes calldata data, uint256 index) view returns (address)",
        "function predictAccountAddress(address implementation, bytes calldata initData, uint256 salt) view returns (address)"
    ];

    const factory = new ethers.Contract(factoryAddr, abi, provider);

    try {
        console.log("Trying getAccountAddress...");
        // Kernel v3.1 usually takes (validator, data, index)
        // data = abi.encodePacked(owner) for ECDSA validator usually?
        const data = owner; // 20 bytes
        const index = 0n;

        // Note: ethers v6 auto-converts address to bytes if needed? No, bytes calldata needs hex string.
        // Assuming data is owner address encoded.
        // ECDSAValidator enables by passing owner address as data.

        const addr = await factory.getAccountAddress(validatorAddr, data, index);
        console.log(`\n🎉 DERIVED ADDRESS: ${addr}`);

    } catch (e: any) {
        console.error("Method failed:", e.message);
        // Try alternate encoding
        try {
            const data = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [owner]);
            const addr = await factory.getAccountAddress(validatorAddr, data, 0n);
            console.log(`\n🎉 DERIVED ADDRESS (Encoded): ${addr}`);
        } catch (e2: any) {
            console.error("Alternate encoding failed:" + e2.message);
        }
    }
}

main();
